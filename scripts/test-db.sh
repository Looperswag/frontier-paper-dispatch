#!/usr/bin/env bash
set -euo pipefail
export SUPABASE_TELEMETRY_DISABLED=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE="$ROOT/node_modules/.bin/supabase"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontier-paper-dispatch}"
LOCK_DIR="${TMPDIR:-/tmp}/${DB_CONTAINER}.test.lock"
STARTED_HERE=0
LOCK_HELD=0
CONCURRENCY_DIR=""
CONCURRENCY_BARRIER_NAME=""
CONCURRENCY_BARRIER_PID=""

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [[ -L "$LOCK_DIR" || ! -d "$LOCK_DIR" ]]; then
      printf 'Unsafe database test lock path: %s\n' "$LOCK_DIR" >&2
      exit 3
    fi
    local holder=""
    if [[ -f "$LOCK_DIR/pid" ]]; then
      holder="$(<"$LOCK_DIR/pid")"
    fi
    if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      printf 'Database test is already running (pid %s).\n' "$holder" >&2
      exit 3
    fi
    rm -f "$LOCK_DIR/pid"
    if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
      printf 'Could not recover stale database test lock: %s\n' "$LOCK_DIR" >&2
      exit 3
    fi
  fi
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  LOCK_HELD=1
}

cleanup() {
  release_concurrency_barrier >/dev/null 2>&1 || true
  if [[ -n "$CONCURRENCY_DIR" ]]; then
    cleanup_api_quota_race >/dev/null 2>&1 || true
    cleanup_feedback_redemption_race >/dev/null 2>&1 || true
    cleanup_digest_snapshot_race >/dev/null 2>&1 || true
    rm -rf "$CONCURRENCY_DIR"
  fi
  if [[ "$STARTED_HERE" == "1" ]]; then
    "$SUPABASE" stop --no-backup >/dev/null 2>&1 || true
  fi
  if [[ "$LOCK_HELD" == "1" ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

cleanup_api_quota_race() {
  docker exec -i -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
drop trigger if exists api_quota_gc_test_barrier on public.api_rate_limit_buckets;
drop function if exists public.api_quota_gc_test_barrier();
delete from public.llm_budget_reservations
where subject in ('90000000-0000-4000-8000-000000000009', 'system:ingest');
delete from public.llm_budget_days
where subject in (
  'global',
  '90000000-0000-4000-8000-000000000009',
  'system:ingest'
);
delete from public.api_rate_limit_buckets
where policy = 'auth_login'
  and subject in (
    'v1:9999999999999999999999999999999999999999999999999999999999999999',
    'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'v1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  );
SQL
}

release_concurrency_barrier() {
  if [[ -z "$CONCURRENCY_BARRIER_NAME" ]]; then
    return 0
  fi
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where application_name = 'quota-barrier-${CONCURRENCY_BARRIER_NAME}-holder';" \
    >/dev/null 2>&1 || true
  if [[ -n "$CONCURRENCY_BARRIER_PID" ]]; then
    wait "$CONCURRENCY_BARRIER_PID" >/dev/null 2>&1 || true
  fi
  CONCURRENCY_BARRIER_NAME=""
  CONCURRENCY_BARRIER_PID=""
}

start_concurrency_barrier() {
  local name="$1"
  if [[ ! "$name" =~ ^[a-z0-9-]+$ ]] || [[ -n "$CONCURRENCY_BARRIER_NAME" ]]; then
    printf 'Invalid or nested concurrency barrier: %s\n' "$name" >&2
    return 1
  fi
  CONCURRENCY_BARRIER_NAME="$name"
  docker exec -i \
    -e "PGAPPNAME=quota-barrier-${name}-holder" \
    -e "PGOPTIONS=-c statement_timeout=30000" \
    "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    > "$CONCURRENCY_DIR/barrier-${name}-holder" 2>&1 <<SQL &
select pg_advisory_lock(
  hashtextextended('frontier:test:api-quota-barrier:${name}', 0)
);
select pg_sleep(25);
SQL
  CONCURRENCY_BARRIER_PID="$!"

  local index
  for ((index = 1; index <= 100; index += 1)); do
    if [[ "$(docker exec -i "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select count(*) from pg_catalog.pg_locks as lock join pg_catalog.pg_stat_activity as activity using (pid) where activity.application_name = 'quota-barrier-${name}-holder' and lock.locktype = 'advisory' and lock.granted;")" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'Concurrency barrier %s was never acquired.\n' "$name" >&2
  release_concurrency_barrier
  return 1
}

release_concurrency_barrier_when_waiting() {
  local name="$1"
  local expected="$2"
  if [[ "$CONCURRENCY_BARRIER_NAME" != "$name" ]] \
    || [[ ! "$expected" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Invalid concurrency barrier wait: %s/%s\n' "$name" "$expected" >&2
    release_concurrency_barrier
    return 1
  fi

  local index waiting
  for ((index = 1; index <= 200; index += 1)); do
    waiting="$(docker exec -i "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select count(*) from pg_catalog.pg_locks as lock join pg_catalog.pg_stat_activity as activity using (pid) where activity.application_name like 'quota-barrier-${name}-worker-%' and lock.locktype = 'advisory' and not lock.granted;")"
    if [[ "$waiting" == "$expected" ]]; then
      release_concurrency_barrier
      return 0
    fi
    sleep 0.05
  done
  printf 'Concurrency barrier %s saw %s/%s waiting workers.\n' \
    "$name" "${waiting:-0}" "$expected" >&2
  release_concurrency_barrier
  return 1
}

assert_api_quota_races() {
  CONCURRENCY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontier-api-quota-race.XXXXXX")"
  cleanup_api_quota_race

  start_concurrency_barrier rate
  local pids=()
  local index
  for ((index = 1; index <= 12; index += 1)); do
    docker exec -i \
      -e "PGAPPNAME=quota-barrier-rate-worker-$index" \
      -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:rate', 0)); set local role service_role; select outcome from public.consume_api_rate_limits('auth_login', null, 'v1:9999999999999999999999999999999999999999999999999999999999999999'); commit;" \
      > "$CONCURRENCY_DIR/rate-$index" &
    pids+=("$!")
  done
  local status=0
  local pid
  if ! release_concurrency_barrier_when_waiting rate 12; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "allowed" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/rate-*)" -ne 5 ]] \
    || [[ "$(awk '$0 == "rate_limited" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/rate-*)" -ne 7 ]]; then
    printf 'Concurrent rate-limit outcomes were not exactly 5 allowed / 7 denied.\n' >&2
    sort "$CONCURRENCY_DIR"/rate-* >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
insert into public.api_rate_limit_buckets (
  policy, dimension, subject, tokens, last_refilled_at, expires_at
) values
  (
    'auth_login', 'ip',
    'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    0, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 second'
  ),
  (
    'auth_login', 'ip',
    'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    0, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 second'
  );
SQL
  pids=()
  start_concurrency_barrier stale
  local fingerprint
  index=0
  for fingerprint in \
    'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; do
    index=$((index + 1))
    docker exec -i \
      -e "PGAPPNAME=quota-barrier-stale-worker-$index" \
      -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:stale', 0)); set local role service_role; select outcome from public.consume_api_rate_limits('auth_login', null, '$fingerprint'); commit;" \
      > "$CONCURRENCY_DIR/stale-$index" &
    pids+=("$!")
  done
  status=0
  if ! release_concurrency_barrier_when_waiting stale 2; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "allowed" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/stale-*)" -ne 2 ]]; then
    printf 'Concurrent refresh of distinct expired buckets deadlocked or failed.\n' >&2
    sort "$CONCURRENCY_DIR"/stale-* >&2
    cleanup_api_quota_race || true
    return 1
  fi

  # Stop a target request immediately after its conflict upsert. A concurrent
  # cleaner must skip the target tuple, not delete it before the RPC locks it.
  cleanup_api_quota_race
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
insert into public.api_rate_limit_buckets (
  policy, dimension, subject, tokens, last_refilled_at, expires_at
) values (
  'auth_login', 'ip',
  'v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  0, clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 second'
);
create or replace function public.api_quota_gc_test_barrier()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('application_name') = 'quota-gc-victim' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('frontier:test:api-quota-gc-barrier', 0)
    );
  end if;
  return null;
end;
$$;
create trigger api_quota_gc_test_barrier
after insert on public.api_rate_limit_buckets
for each statement execute function public.api_quota_gc_test_barrier();
SQL

  docker exec -i \
    -e "PGAPPNAME=quota-gc-barrier-holder" \
    -e "PGOPTIONS=-c statement_timeout=15000" \
    "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    > "$CONCURRENCY_DIR/gc-barrier-holder" 2>&1 <<'SQL' &
select pg_advisory_lock(
  hashtextextended('frontier:test:api-quota-gc-barrier', 0)
);
select pg_sleep(12);
SQL
  local gc_barrier_pid="$!"
  local lock_seen=0
  for ((index = 1; index <= 100; index += 1)); do
    if [[ "$(docker exec -i "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select count(*) from pg_catalog.pg_locks as lock join pg_catalog.pg_stat_activity as activity using (pid) where activity.application_name = 'quota-gc-barrier-holder' and lock.locktype = 'advisory' and lock.granted;")" == "1" ]]; then
      lock_seen=1
      break
    fi
    sleep 0.05
  done
  if [[ "$lock_seen" -ne 1 ]]; then
    printf 'GC race barrier holder never acquired its advisory lock.\n' >&2
    wait "$gc_barrier_pid" || true
    cleanup_api_quota_race || true
    return 1
  fi

  docker exec -i \
    -e "PGAPPNAME=quota-gc-victim" \
    -e "PGOPTIONS=-c statement_timeout=15000" \
    "$DB_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "set role service_role; select outcome from public.consume_api_rate_limits('auth_login', null, 'v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');" \
    > "$CONCURRENCY_DIR/gc-victim" 2>&1 &
  local gc_victim_pid="$!"
  local waiter_seen=0
  for ((index = 1; index <= 100; index += 1)); do
    if [[ "$(docker exec -i "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select count(*) from pg_catalog.pg_locks as lock join pg_catalog.pg_stat_activity as activity using (pid) where activity.application_name = 'quota-gc-victim' and lock.locktype = 'advisory' and not lock.granted;")" == "1" ]]; then
      waiter_seen=1
      break
    fi
    sleep 0.05
  done
  if [[ "$waiter_seen" -ne 1 ]]; then
    printf 'GC victim request never reached the post-upsert barrier.\n' >&2
    docker exec -i "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where application_name in ('quota-gc-barrier-holder', 'quota-gc-victim');" >/dev/null || true
    wait "$gc_barrier_pid" || true
    wait "$gc_victim_pid" || true
    cleanup_api_quota_race || true
    return 1
  fi

  local gc_cleaner_status=0
  docker exec -i \
    -e "PGAPPNAME=quota-gc-cleaner" \
    -e "PGOPTIONS=-c statement_timeout=10000" \
    "$DB_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "set role service_role; select outcome from public.consume_api_rate_limits('auth_login', null, 'v1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');" \
    > "$CONCURRENCY_DIR/gc-cleaner" 2>&1 || gc_cleaner_status=$?

  docker exec -i "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where application_name = 'quota-gc-barrier-holder';" >/dev/null || true
  wait "$gc_barrier_pid" || true
  local gc_victim_status=0
  wait "$gc_victim_pid" || gc_victim_status=$?
  local victim_state
  victim_state="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select count(*) || ':' || count(*) filter (where expires_at > clock_timestamp()) from public.api_rate_limit_buckets where policy = 'auth_login' and dimension = 'ip' and subject = 'v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';")"
  if [[ "$gc_cleaner_status" -ne 0 ]] \
    || [[ "$(cat "$CONCURRENCY_DIR/gc-cleaner")" != "allowed" ]] \
    || [[ "$gc_victim_status" -ne 0 ]] \
    || [[ "$(cat "$CONCURRENCY_DIR/gc-victim")" != "allowed" ]] \
    || [[ "$victim_state" != "1:1" ]]; then
    printf 'GC deleted or invalidated a target bucket between conflict upsert and row lock.\n' >&2
    cat "$CONCURRENCY_DIR/gc-cleaner" "$CONCURRENCY_DIR/gc-victim" >&2
    printf 'victim_state=%s cleaner_status=%s victim_status=%s\n' \
      "$victim_state" "$gc_cleaner_status" "$gc_victim_status" >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  start_concurrency_barrier budget
  pids=()
  for ((index = 1; index <= 10; index += 1)); do
    docker exec -i \
      -e "PGAPPNAME=quota-barrier-budget-worker-$index" \
      -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:budget', 0)); set local role service_role; select outcome from public.reserve_llm_budget('web_chat', '90000000-0000-4000-8000-000000000009', gen_random_uuid(), 65536); commit;" \
      > "$CONCURRENCY_DIR/budget-$index" &
    pids+=("$!")
  done
  status=0
  if ! release_concurrency_barrier_when_waiting budget 10; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "reserved" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/budget-*)" -ne 3 ]] \
    || [[ "$(awk '$0 == "budget_exhausted" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/budget-*)" -ne 7 ]]; then
    printf 'Concurrent LLM reservations were not capped at three dispatches.\n' >&2
    sort "$CONCURRENCY_DIR"/budget-* >&2
    cleanup_api_quota_race || true
    return 1
  fi
  local usage
  usage="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select reserved_tokens || ':' || consumed_tokens from public.llm_budget_days where dimension = 'subject' and subject = '90000000-0000-4000-8000-000000000009';")"
  if [[ "$usage" != "196608:0" ]]; then
    printf 'Concurrent LLM reservation total mismatch: %s\n' "$usage" >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  start_concurrency_barrier idempotent
  pids=()
  for ((index = 1; index <= 6; index += 1)); do
    docker exec -i \
      -e "PGAPPNAME=quota-barrier-idempotent-worker-$index" \
      -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:idempotent', 0)); set local role service_role; select outcome from public.reserve_llm_budget('web_chat', '90000000-0000-4000-8000-000000000009', '99999999-9999-4999-8999-999999999991', 50000); commit;" \
      > "$CONCURRENCY_DIR/idempotent-$index" &
    pids+=("$!")
  done
  status=0
  if ! release_concurrency_barrier_when_waiting idempotent 6; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "reserved" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/idempotent-*)" -ne 1 ]] \
    || [[ "$(awk '$0 == "existing" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/idempotent-*)" -ne 5 ]]; then
    printf 'Concurrent duplicate reservations were not idempotent.\n' >&2
    sort "$CONCURRENCY_DIR"/idempotent-* >&2
    cleanup_api_quota_race || true
    return 1
  fi
  local reservation_id
  reservation_id="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select id from public.llm_budget_reservations where request_id = '99999999-9999-4999-8999-999999999991';")"
  start_concurrency_barrier settle
  pids=()
  for ((index = 1; index <= 6; index += 1)); do
    docker exec -i \
      -e "PGAPPNAME=quota-barrier-settle-worker-$index" \
      -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:settle', 0)); set local role service_role; select outcome from public.settle_llm_budget('$reservation_id', '90000000-0000-4000-8000-000000000009', 1234); commit;" \
      > "$CONCURRENCY_DIR/settle-$index" &
    pids+=("$!")
  done
  status=0
  if ! release_concurrency_barrier_when_waiting settle 6; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "settled" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/settle-*)" -ne 1 ]] \
    || [[ "$(awk '$0 == "existing" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/settle-*)" -ne 5 ]]; then
    printf 'Concurrent settlements were not idempotent.\n' >&2
    sort "$CONCURRENCY_DIR"/settle-* >&2
    cleanup_api_quota_race || true
    return 1
  fi
  usage="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select string_agg(reserved_tokens || ':' || consumed_tokens, ',' order by dimension) from public.llm_budget_days where subject in ('global', '90000000-0000-4000-8000-000000000009');")"
  if [[ "$usage" != "0:1234,0:1234" ]]; then
    printf 'Concurrent settlement total mismatch: %s\n' "$usage" >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  docker exec -i \
    -e "PGAPPNAME=quota-cross-date-holder" \
    -e "PGOPTIONS=-c statement_timeout=15000" \
    "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
    > "$CONCURRENCY_DIR/cross-date-holder" 2>&1 <<'SQL' &
begin;
select pg_advisory_xact_lock(
  hashtextextended(
    'frontier:llm-request:96666666-6666-4666-8666-666666666666',
    0
  )
);
insert into public.llm_budget_days (
  budget_date, dimension, subject, token_limit,
  reserved_tokens, consumed_tokens, created_at, updated_at
) values
  (
    '2001-01-01', 'global', 'global', 500000,
    45000, 0, '2001-01-01T00:00:00+08', '2001-01-01T00:00:00+08'
  ),
  (
    '2001-01-01', 'subject',
    '90000000-0000-4000-8000-000000000009', 200000,
    45000, 0, '2001-01-01T00:00:00+08', '2001-01-01T00:00:00+08'
  );
insert into public.llm_budget_reservations (
  id, request_id, policy, subject, budget_date, reserved_tokens, created_at
) values (
  '95555555-5555-4555-8555-555555555555',
  '96666666-6666-4666-8666-666666666666',
  'web_chat',
  '90000000-0000-4000-8000-000000000009',
  '2001-01-01',
  45000,
  '2001-01-01T00:00:00+08'
);
select pg_sleep(6);
commit;
SQL
  local holder_pid="$!"
  local lock_seen=0
  for ((index = 1; index <= 100; index += 1)); do
    if [[ "$(docker exec -i "$DB_CONTAINER" \
      psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "select count(*) from pg_catalog.pg_locks as lock join pg_catalog.pg_stat_activity as activity using (pid) where activity.application_name = 'quota-cross-date-holder' and lock.locktype = 'advisory' and lock.granted;")" == "1" ]]; then
      lock_seen=1
      break
    fi
    sleep 0.05
  done
  if [[ "$lock_seen" -ne 1 ]]; then
    printf 'Cross-date race holder never acquired its request advisory lock.\n' >&2
    wait "$holder_pid" || true
    cleanup_api_quota_race || true
    return 1
  fi

  docker exec -i \
    -e "PGAPPNAME=quota-cross-date-caller" \
    -e "PGOPTIONS=-c statement_timeout=15000" \
    "$DB_CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "set role service_role; select outcome || ':' || reservation_id || ':' || budget_date from public.reserve_llm_budget('web_chat', '90000000-0000-4000-8000-000000000009', '96666666-6666-4666-8666-666666666666', 45000);" \
    > "$CONCURRENCY_DIR/cross-date-caller" 2>&1 &
  local caller_pid="$!"
  status=0
  wait "$holder_pid" || status=1
  wait "$caller_pid" || status=1
  if [[ "$status" -ne 0 ]] \
    || [[ "$(cat "$CONCURRENCY_DIR/cross-date-caller")" != "existing:95555555-5555-4555-8555-555555555555:2001-01-01" ]]; then
    printf 'A same-request race across Shanghai dates was not idempotent.\n' >&2
    cat "$CONCURRENCY_DIR/cross-date-holder" >&2
    cat "$CONCURRENCY_DIR/cross-date-caller" >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  docker exec -i -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
set role service_role;
select outcome
from generate_series(1, 3) as request
cross join lateral public.reserve_llm_budget(
  'web_chat',
  '90000000-0000-4000-8000-000000000009',
  ('91111111-1111-4111-8111-' || lpad(request::text, 12, '0'))::uuid,
  60000
);
select outcome
from generate_series(1, 5) as request
cross join lateral public.reserve_llm_budget(
  'root_rank',
  'system:ingest',
  ('92222222-2222-4222-8222-' || lpad(request::text, 12, '0'))::uuid,
  60000
);
SQL
  start_concurrency_barrier mixed
  pids=()
  docker exec -i \
    -e "PGAPPNAME=quota-barrier-mixed-worker-web" \
    -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:mixed', 0)); set local role service_role; select outcome from public.reserve_llm_budget('web_chat', '90000000-0000-4000-8000-000000000009', '98888888-8888-4888-8888-888888888888', 20000); commit;" \
    > "$CONCURRENCY_DIR/mixed-web" &
  pids+=("$!")
  docker exec -i \
    -e "PGAPPNAME=quota-barrier-mixed-worker-root" \
    -e "PGOPTIONS=-c statement_timeout=10000" "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "begin; select pg_advisory_xact_lock_shared(hashtextextended('frontier:test:api-quota-barrier:mixed', 0)); set local role service_role; select outcome from public.reserve_llm_budget('root_summary', 'system:ingest', '97777777-7777-4777-8777-777777777777', 20000); commit;" \
    > "$CONCURRENCY_DIR/mixed-root" &
  pids+=("$!")
  status=0
  if ! release_concurrency_barrier_when_waiting mixed 2; then
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    cleanup_api_quota_race || true
    return 1
  fi
  for pid in "${pids[@]}"; do
    wait "$pid" || status=1
  done
  if [[ "$status" -ne 0 ]] \
    || [[ "$(awk '$0 == "reserved" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/mixed-*)" -ne 1 ]] \
    || [[ "$(awk '$0 == "budget_exhausted" { count += 1 } END { print count + 0 }' "$CONCURRENCY_DIR"/mixed-*)" -ne 1 ]]; then
    printf 'Concurrent Root/Web reservations did not share one global cap.\n' >&2
    sort "$CONCURRENCY_DIR"/mixed-* >&2
    cleanup_api_quota_race || true
    return 1
  fi
  usage="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select reserved_tokens || ':' || consumed_tokens from public.llm_budget_days where dimension = 'global' and subject = 'global';")"
  if [[ "$usage" != "500000:0" ]]; then
    printf 'Concurrent project-global budget mismatch: %s\n' "$usage" >&2
    cleanup_api_quota_race || true
    return 1
  fi

  cleanup_api_quota_race
  rm -rf "$CONCURRENCY_DIR"
  CONCURRENCY_DIR=""
}

run_tap_file() {
  local test_file="$1"
  local tap_output
  tap_output="$({
    docker exec -i "$DB_CONTAINER" \
      psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres < "$test_file"
  } 2>&1)" || {
    printf '%s\n' "$tap_output" >&2
    return 1
  }
  printf '%s\n' "$tap_output"
  if printf '%s\n' "$tap_output" | grep -Eq '^(not ok |# Looks like |Bail out!)'; then
    printf 'pgTAP failure in %s\n' "$test_file" >&2
    return 1
  fi
  local planned executed
  planned="$(printf '%s\n' "$tap_output" | awk '/^1\.\.[0-9]+$/ { sub(/^1\.\./, ""); value=$0 } END { print value }')"
  executed="$(printf '%s\n' "$tap_output" | awk '/^(ok|not ok) [0-9]+ / { count += 1 } END { print count + 0 }')"
  if [[ ! "$planned" =~ ^[0-9]+$ ]] || [[ "$executed" -ne "$planned" ]]; then
    printf 'Invalid TAP plan in %s: planned=%s executed=%s\n' \
      "$test_file" "${planned:-missing}" "$executed" >&2
    return 1
  fi
}

acquire_lock
trap cleanup EXIT

assert_role_denied() {
  local role="$1"
  local output
  if output="$({
    docker exec -i "$DB_CONTAINER" \
      psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; set local role $role; select count(*) from public.items; rollback;"
  } 2>&1)"; then
    printf 'Expected public.items access to be denied for role %s.\n' "$role" >&2
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -Eqi 'permission denied|42501'; then
    printf 'Unexpected role probe failure for %s:\n%s\n' "$role" "$output" >&2
    return 1
  fi
}

assert_table_denied() {
  local role="$1"
  local table="$2"
  local output
  if output="$({
    docker exec -i "$DB_CONTAINER" \
      psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; set local role $role; select count(*) from public.$table; rollback;"
  } 2>&1)"; then
    printf 'Expected public.%s access to be denied for role %s.\n' "$table" "$role" >&2
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -Eqi 'permission denied|42501'; then
    printf 'Unexpected table denial for %s on public.%s:\n%s\n' "$role" "$table" "$output" >&2
    return 1
  fi
}

assert_function_denied() {
  local role="$1"
  local output
  if output="$({
    docker exec -i "$DB_CONTAINER" \
      psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "begin; set local role $role; select * from public.redeem_feedback_token(1::smallint, repeat('f', 64), '2026-07-10', '11111111-1111-4111-8111-111111111111', 'up', clock_timestamp() + interval '1 day'); rollback;"
  } 2>&1)"; then
    printf 'Expected feedback redemption execute to be denied for role %s.\n' "$role" >&2
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -Eqi 'permission denied|42501'; then
    printf 'Unexpected function denial for %s:\n%s\n' "$role" "$output" >&2
    return 1
  fi
}

cleanup_feedback_redemption_race() {
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
drop trigger if exists feedback_redemption_race_delay on public.feedback_token_redemptions;
drop function if exists public.feedback_redemption_race_delay();
delete from public.feedback where item_id = '99999999-9999-4999-8999-999999999999';
delete from public.feedback_token_redemptions
where item_id = '99999999-9999-4999-8999-999999999999';
delete from public.digests where digest_date = '2099-02-01';
delete from public.items where id = '99999999-9999-4999-8999-999999999999';
SQL
}

cleanup_digest_snapshot_race() {
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
drop trigger if exists digest_snapshot_race_delay on public.digests;
drop function if exists public.digest_snapshot_race_delay();
delete from public.digests where digest_date = '2099-04-01';
delete from public.items
where id in (
  '77777777-7777-4777-8777-777777777771',
  '77777777-7777-4777-8777-777777777772'
);
SQL
}

assert_feedback_redemption_race() {
  CONCURRENCY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontier-feedback-race.XXXXXX")"
  local first="$CONCURRENCY_DIR/first"
  local second="$CONCURRENCY_DIR/second"
  local call_sql
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
insert into public.items(id, source, external_id, title)
values ('99999999-9999-4999-8999-999999999999', 'feedback-race', 'race', 'Race')
on conflict (id) do nothing;
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values (
  '99999999-9999-4999-8999-999999999998',
  '2099-02-01',
  array['99999999-9999-4999-8999-999999999999'::uuid],
  'race'
)
on conflict (digest_date) do update set top5_item_ids = excluded.top5_item_ids;
delete from public.feedback where item_id = '99999999-9999-4999-8999-999999999999';
delete from public.feedback_token_redemptions
where item_id = '99999999-9999-4999-8999-999999999999';
create or replace function public.feedback_redemption_race_delay()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_sleep(0.5);
  return new;
end;
$$;
create trigger feedback_redemption_race_delay
before insert on public.feedback_token_redemptions
for each row execute function public.feedback_redemption_race_delay();
SQL

  call_sql="set role service_role; select outcome from public.redeem_feedback_token(1::smallint, repeat('9', 64), '2099-02-01', '99999999-9999-4999-8999-999999999999', 'up', '2099-03-01T00:00:00Z');"
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$call_sql" > "$first" &
  local first_pid=$!
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$call_sql" > "$second" &
  local second_pid=$!
  local first_status=0
  local second_status=0
  wait "$first_pid" || first_status=$?
  wait "$second_pid" || second_status=$?

  if [[ "$first_status" -ne 0 || "$second_status" -ne 0 ]]; then
    printf 'Concurrent redemption session failed: first=%s second=%s\n' \
      "$first_status" "$second_status" >&2
    cleanup_feedback_redemption_race || true
    return 1
  fi

  if [[ "$(sort "$first" "$second")" != $'already_redeemed\nrecorded' ]]; then
    printf 'Unexpected concurrent redemption outcomes:\n' >&2
    cat "$first" "$second" >&2
    cleanup_feedback_redemption_race || true
    return 1
  fi
  local persisted
  persisted="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select (select count(*) from public.feedback_token_redemptions where item_id = '99999999-9999-4999-8999-999999999999')::text || ':' || (select count(*) from public.feedback where item_id = '99999999-9999-4999-8999-999999999999')::text || ':' || (select rating from public.feedback where item_id = '99999999-9999-4999-8999-999999999999');")"
  if [[ "$persisted" != "1:1:up" ]]; then
    printf 'Concurrent redemption persistence mismatch: %s\n' "$persisted" >&2
    cleanup_feedback_redemption_race || true
    return 1
  fi
  cleanup_feedback_redemption_race
  rm -rf "$CONCURRENCY_DIR"
  CONCURRENCY_DIR=""
}

assert_digest_snapshot_race() {
  CONCURRENCY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontier-digest-race.XXXXXX")"
  local first="$CONCURRENCY_DIR/first"
  local second="$CONCURRENCY_DIR/second"
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
insert into public.items(id, source, external_id, title)
values
  ('77777777-7777-4777-8777-777777777771', 'digest-race', 'one', 'One'),
  ('77777777-7777-4777-8777-777777777772', 'digest-race', 'two', 'Two')
on conflict (id) do nothing;
delete from public.digests where digest_date = '2099-04-01';
create or replace function public.digest_snapshot_race_delay()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.digest_date = '2099-04-01' then
    perform pg_catalog.pg_sleep(0.5);
  end if;
  return new;
end;
$$;
create trigger digest_snapshot_race_delay
before insert on public.digests
for each row execute function public.digest_snapshot_race_delay();
SQL

  local first_sql second_sql
  first_sql="set role service_role; select outcome, persisted_top5_item_ids[1], persisted_rendered_md, persisted_summary_count from public.store_digest_bundle('2099-04-01', array['77777777-7777-4777-8777-777777777771'::uuid], array['first'], array['first summary'], array['first impact'], array[99], array[1], '# first');"
  second_sql="set role service_role; select outcome, persisted_top5_item_ids[1], persisted_rendered_md, persisted_summary_count from public.store_digest_bundle('2099-04-01', array['77777777-7777-4777-8777-777777777772'::uuid], array['second'], array['second summary'], array['second impact'], array[98], array[1], '# second');"
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$first_sql" > "$first" &
  local first_pid=$!
  docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$second_sql" > "$second" &
  local second_pid=$!
  local first_status=0
  local second_status=0
  wait "$first_pid" || first_status=$?
  wait "$second_pid" || second_status=$?
  if [[ "$first_status" -ne 0 || "$second_status" -ne 0 ]]; then
    printf 'Concurrent digest session failed: first=%s second=%s\n' \
      "$first_status" "$second_status" >&2
    cleanup_digest_snapshot_race || true
    return 1
  fi

  local outcomes snapshots persisted summaries
  outcomes="$(cut -d '|' -f 1 "$first" "$second" | sort)"
  snapshots="$(cut -d '|' -f 2- "$first" "$second" | sort -u)"
  persisted="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select top5_item_ids[1], rendered_md, 1 from public.digests where digest_date = '2099-04-01';")"
  summaries="$(docker exec -i "$DB_CONTAINER" \
    psql -X -q -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "select item_id, one_liner, count(*) over () from public.summaries where item_id in ('77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772');")"
  if [[ "$outcomes" != $'conflict\ninserted' ]] \
    || [[ "$(printf '%s\n' "$snapshots" | wc -l | tr -d ' ')" != "1" ]] \
    || [[ "$persisted" != "$snapshots" ]] \
    || { [[ "$persisted" == 77777777-7777-4777-8777-777777777771* ]] \
      && [[ "$summaries" != "77777777-7777-4777-8777-777777777771|first|1" ]]; } \
    || { [[ "$persisted" == 77777777-7777-4777-8777-777777777772* ]] \
      && [[ "$summaries" != "77777777-7777-4777-8777-777777777772|second|1" ]]; }; then
    printf 'Unexpected concurrent digest result:\n' >&2
    cat "$first" "$second" >&2
    printf 'persisted=%s summaries=%s\n' "$persisted" "$summaries" >&2
    cleanup_digest_snapshot_race || true
    return 1
  fi
  cleanup_digest_snapshot_race
  rm -rf "$CONCURRENCY_DIR"
  CONCURRENCY_DIR=""
}

if docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -qx true \
  || "$SUPABASE" status >/dev/null 2>&1; then
  if [[ "${ALLOW_LOCAL_DB_RESET:-0}" != "1" ]]; then
    printf '%s\n' \
      'Refusing to reset an existing local Supabase instance.' \
      'Stop it first, or set ALLOW_LOCAL_DB_RESET=1 if destructive reset is intentional.' >&2
    exit 2
  fi
else
  STARTED_HERE=1
  "$SUPABASE" start \
    -x studio,imgproxy,edge-runtime,logflare,vector,realtime,storage-api,mailpit,postgres-meta,supavisor,gotrue,kong,postgrest
fi

# Prove that an installation already on the two legacy migrations upgrades safely.
"$SUPABASE" db reset --local --version 0002 --no-seed
docker exec -i "$DB_CONTAINER" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
insert into public.items(
  id, source, external_id, url, title, authors, abstract, published_at, signals, fetched_at
) values
  (
    'c1000000-0000-4000-8000-000000000001', 'arxiv', '2607.00001',
    'https://arxiv.org/abs/2607.00001', 'Legacy shared paper', array['Alice'],
    'arxiv abstract', '2026-07-01', '{"citations":1}', '2026-07-01T00:00:00Z'
  ),
  (
    'c1000000-0000-4000-8000-000000000002', 'huggingface', '2607.00001',
    'https://huggingface.co/papers/2607.00001', 'Legacy shared paper', array['Alice'],
    'huggingface abstract', '2026-07-01', '{"upvotes":2}', '2026-07-02T00:00:00Z'
  ),
  (
    'c1000000-0000-4000-8000-000000000003', 'blog',
    'https://example.com/posts/stable-guid', 'https://example.com/posts/stable-guid',
    'Original publisher title', '{}', 'blog abstract', '2026-07-01',
    '{"social":3}', '2026-07-03T00:00:00Z'
  ),
  (
    'c1000000-0000-4000-8000-000000000006', 'blog', repeat('x', 6000),
    'https://example.com/posts/oversized-legacy-guid', 'Oversized legacy identity',
    '{}', '', '2026-07-01', '{}', '2026-07-04T00:00:00Z'
  );
insert into public.digests(id, digest_date, top5_item_ids, rendered_md)
values (
  'c1000000-0000-4000-8000-000000000004', '2001-01-01',
  array['c1000000-0000-4000-8000-000000000002'::uuid], 'legacy digest'
);
insert into public.summaries(
  id, item_id, one_liner, summary_md, impact_md, score, rank, model
) values (
  'c1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000002',
  'legacy', 'legacy', 'legacy', 80, 1, 'legacy'
);
SQL
"$SUPABASE" migration up --local
docker exec -i "$DB_CONTAINER" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$ROOT/supabase/tests/database/populated-upgrade.sql" >/dev/null
run_tap_file "$ROOT/supabase/tests/database/security.test.sql"

# A second full empty rebuild catches ordering, repeatability, and seed regressions.
"$SUPABASE" db reset --local
"$SUPABASE" db reset --local
"$SUPABASE" migration list --local

# Re-running seed against the same database must neither fail nor multiply fixtures.
docker exec -i "$DB_CONTAINER" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$ROOT/supabase/seed.sql" >/dev/null
docker exec -i "$DB_CONTAINER" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$ROOT/supabase/seed.sql" >/dev/null

for test_file in "$ROOT"/supabase/tests/database/*.test.sql; do
  run_tap_file "$test_file"
done

assert_role_denied anon
assert_role_denied authenticated
assert_table_denied service_role api_rate_limit_buckets
assert_table_denied service_role feedback_token_redemptions
assert_table_denied service_role llm_budget_days
assert_table_denied service_role llm_budget_reservations
assert_table_denied service_role delivery_outbox
assert_table_denied service_role delivery_alerts
assert_table_denied service_role summary_versions
assert_table_denied service_role digest_items
assert_table_denied service_role item_identity_aliases
assert_table_denied service_role item_observations
assert_function_denied anon
assert_function_denied authenticated
assert_api_quota_races
assert_feedback_redemption_race
assert_digest_snapshot_race
docker exec -i "$DB_CONTAINER" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$ROOT/supabase/tests/database/role-behavior.sql" >/dev/null

"$SUPABASE" db lint --local --schema public --level warning --fail-on error
