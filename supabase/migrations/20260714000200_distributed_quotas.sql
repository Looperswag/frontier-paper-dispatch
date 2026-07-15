-- Distributed request throttling and a project-wide hard LLM token budget.
-- All counters are sealed behind service-role-only SECURITY DEFINER RPCs so
-- every server instance observes the same database-clock state.

create table public.api_rate_limit_buckets (
  policy text not null,
  dimension text not null,
  subject text not null,
  tokens numeric(20, 6) not null,
  last_refilled_at timestamptz not null,
  expires_at timestamptz not null,
  constraint api_rate_limit_buckets_pkey
    primary key (policy, dimension, subject),
  constraint api_rate_limit_buckets_policy_check
    check (policy in ('auth_login', 'owner_write', 'web_chat')),
  constraint api_rate_limit_buckets_dimension_check
    check (dimension in ('ip', 'user')),
  constraint api_rate_limit_buckets_subject_check
    check (
      (dimension = 'ip' and subject ~ '^v[1-9][0-9]{0,5}:[0-9a-f]{64}$')
      or
      (dimension = 'user' and subject ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    ),
  constraint api_rate_limit_buckets_tokens_check
    check (tokens >= 0),
  constraint api_rate_limit_buckets_time_check
    check (
      isfinite(last_refilled_at)
      and isfinite(expires_at)
      and expires_at > last_refilled_at
    )
);

create index api_rate_limit_buckets_expiry_idx
  on public.api_rate_limit_buckets (expires_at, policy, dimension, subject);

create table public.llm_budget_days (
  budget_date date not null,
  dimension text not null,
  subject text not null,
  token_limit integer not null,
  reserved_tokens bigint not null default 0,
  consumed_tokens bigint not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint llm_budget_days_pkey
    primary key (budget_date, dimension, subject),
  constraint llm_budget_days_date_check
    check (isfinite(budget_date)),
  constraint llm_budget_days_dimension_check
    check (dimension in ('global', 'subject')),
  constraint llm_budget_days_subject_check
    check (
      (dimension = 'global' and subject = 'global')
      or
      (dimension = 'subject' and (
        subject in ('system:ingest', 'system:refine')
        or subject ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ))
    ),
  constraint llm_budget_days_limit_check
    check (token_limit between 1 and 1000000000),
  constraint llm_budget_days_usage_check
    check (
      reserved_tokens >= 0
      and consumed_tokens >= 0
      and reserved_tokens + consumed_tokens <= token_limit
    ),
  constraint llm_budget_days_time_check
    check (isfinite(created_at) and isfinite(updated_at) and updated_at >= created_at)
);

create index llm_budget_days_updated_idx
  on public.llm_budget_days (updated_at, budget_date);

create table public.llm_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  policy text not null,
  subject text not null,
  budget_date date not null,
  day_dimension text not null default 'subject',
  reserved_tokens integer not null,
  charged_tokens integer,
  usage_known boolean,
  status text not null default 'pending',
  created_at timestamptz not null,
  settled_at timestamptz,
  constraint llm_budget_reservations_policy_check
    check (policy in ('web_chat', 'root_rank', 'root_summary', 'root_refine')),
  constraint llm_budget_reservations_subject_check
    check (
      subject in ('system:ingest', 'system:refine')
      or subject ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  constraint llm_budget_reservations_date_check
    check (isfinite(budget_date)),
  constraint llm_budget_reservations_day_dimension_check
    check (day_dimension = 'subject'),
  constraint llm_budget_reservations_reserved_check
    check (reserved_tokens between 1 and 65536),
  constraint llm_budget_reservations_status_check
    check (status in ('pending', 'settled')),
  constraint llm_budget_reservations_settlement_check
    check (
      (
        status = 'pending'
        and charged_tokens is null
        and usage_known is null
        and settled_at is null
      )
      or
      (
        status = 'settled'
        and charged_tokens between 1 and reserved_tokens
        and usage_known is not null
        and settled_at is not null
        and isfinite(settled_at)
      )
    ),
  constraint llm_budget_reservations_created_at_check
    check (isfinite(created_at)),
  constraint llm_budget_reservations_day_fk
    foreign key (budget_date, day_dimension, subject)
    references public.llm_budget_days (budget_date, dimension, subject)
    on update restrict on delete restrict
);

create index llm_budget_reservations_retention_idx
  on public.llm_budget_reservations (budget_date, status, created_at);

alter table public.api_rate_limit_buckets enable row level security;
alter table public.api_rate_limit_buckets force row level security;
alter table public.llm_budget_days enable row level security;
alter table public.llm_budget_days force row level security;
alter table public.llm_budget_reservations enable row level security;
alter table public.llm_budget_reservations force row level security;

revoke all privileges on table public.api_rate_limit_buckets
  from public, anon, authenticated, service_role;
revoke all privileges on table public.llm_budget_days
  from public, anon, authenticated, service_role;
revoke all privileges on table public.llm_budget_reservations
  from public, anon, authenticated, service_role;

create or replace function public.quota_shanghai_date(p_at timestamptz)
returns date
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select (p_at at time zone 'Asia/Shanghai')::date;
$$;

create or replace function public.consume_api_rate_limits(
  p_policy text,
  p_user_id uuid,
  p_ip_fingerprint text
)
returns table (
  outcome text,
  retry_after_seconds integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_cleanup_now timestamptz;
  v_window_seconds integer;
  v_dimensions text[];
  v_subjects text[];
  v_capacities integer[];
  v_refilled numeric[] := array[]::numeric[];
  v_allowed boolean := true;
  v_retry integer := 1;
  v_elapsed numeric;
  v_balance numeric;
  v_row public.api_rate_limit_buckets%rowtype;
begin
  if p_policy is null
    or p_ip_fingerprint is null
    or p_ip_fingerprint !~ '^v[1-9][0-9]{0,5}:[0-9a-f]{64}$' then
    raise exception 'invalid API quota request' using errcode = '22023';
  end if;

  case p_policy
    when 'auth_login' then
      if p_user_id is not null then
        raise exception 'invalid API quota request' using errcode = '22023';
      end if;
      v_window_seconds := 900;
      v_dimensions := array['ip'];
      v_subjects := array[p_ip_fingerprint];
      v_capacities := array[5];
    when 'owner_write' then
      if p_user_id is null then
        raise exception 'invalid API quota request' using errcode = '22023';
      end if;
      v_window_seconds := 60;
      v_dimensions := array['ip', 'user'];
      v_subjects := array[p_ip_fingerprint, p_user_id::text];
      v_capacities := array[120, 60];
    when 'web_chat' then
      if p_user_id is null then
        raise exception 'invalid API quota request' using errcode = '22023';
      end if;
      v_window_seconds := 60;
      v_dimensions := array['ip', 'user'];
      v_subjects := array[p_ip_fingerprint, p_user_id::text];
      v_capacities := array[10, 5];
    else
      raise exception 'invalid API quota request' using errcode = '22023';
  end case;

  for v_position in 1..pg_catalog.cardinality(v_dimensions) loop
    insert into public.api_rate_limit_buckets as target (
      policy,
      dimension,
      subject,
      tokens,
      last_refilled_at,
      expires_at
    ) values (
      p_policy,
      v_dimensions[v_position],
      v_subjects[v_position],
      v_capacities[v_position],
      v_now,
      v_now + pg_catalog.make_interval(secs => v_window_seconds * 2)
    )
    -- The array order is intentionally ip then user. On a conflict, lock the
    -- existing tuple before moving to the next dimension; otherwise the hot
    -- path GC can delete an expired target between this statement and the
    -- aggregate FOR UPDATE below. The false predicate avoids a redundant row
    -- version while PostgreSQL still locks the conflicting tuple.
    on conflict (policy, dimension, subject) do update
    set tokens = target.tokens
    where false;
  end loop;

  -- Every caller takes the same deterministic lock order, so user and IP
  -- dimensions are evaluated and consumed all-or-none without deadlocks.
  perform 1
  from public.api_rate_limit_buckets as bucket
  where bucket.policy = p_policy
    and (
      (
        bucket.dimension = v_dimensions[1]
        and bucket.subject = v_subjects[1]
      )
      or (
        pg_catalog.cardinality(v_dimensions) = 2
        and bucket.dimension = v_dimensions[2]
        and bucket.subject = v_subjects[2]
      )
    )
  order by bucket.dimension, bucket.subject
  for update;

  -- The call may have waited for another transaction after capturing its
  -- initial clock. Never move a bucket clock backwards or refill that interval
  -- twice when lock acquisition order differs from request arrival order.
  select greatest(
    pg_catalog.clock_timestamp(),
    pg_catalog.max(bucket.last_refilled_at)
  ) into strict v_now
  from public.api_rate_limit_buckets as bucket
  where bucket.policy = p_policy
    and (
      (
        bucket.dimension = v_dimensions[1]
        and bucket.subject = v_subjects[1]
      )
      or (
        pg_catalog.cardinality(v_dimensions) = 2
        and bucket.dimension = v_dimensions[2]
        and bucket.subject = v_subjects[2]
      )
    );

  for v_position in 1..pg_catalog.cardinality(v_dimensions) loop
    select bucket.* into strict v_row
    from public.api_rate_limit_buckets as bucket
    where bucket.policy = p_policy
      and bucket.dimension = v_dimensions[v_position]
      and bucket.subject = v_subjects[v_position];

    v_elapsed := greatest(
      0::numeric,
      extract(epoch from (v_now - v_row.last_refilled_at))::numeric
    );
    v_balance := least(
      v_capacities[v_position]::numeric,
      v_row.tokens
        + v_elapsed * v_capacities[v_position]::numeric / v_window_seconds::numeric
    );
    v_refilled := pg_catalog.array_append(v_refilled, v_balance);
    if v_balance < 1 then
      v_allowed := false;
      v_retry := greatest(
        v_retry,
        least(
          v_window_seconds,
          pg_catalog.ceil(
            (1 - v_balance) * v_window_seconds::numeric
              / v_capacities[v_position]::numeric
          )::integer
        )
      );
    end if;
  end loop;

  for v_position in 1..pg_catalog.cardinality(v_dimensions) loop
    update public.api_rate_limit_buckets as bucket
    set tokens = v_refilled[v_position] - case when v_allowed then 1 else 0 end,
        last_refilled_at = v_now,
        expires_at = v_now + pg_catalog.make_interval(secs => v_window_seconds * 2)
    where bucket.policy = p_policy
      and bucket.dimension = v_dimensions[v_position]
      and bucket.subject = v_subjects[v_position];
  end loop;

  -- Bound high-cardinality IP growth without ever waiting for a bucket another
  -- request is using. The just-refreshed rows are no longer expired, and
  -- SKIP LOCKED prevents the cleanup batch from recreating lock inversions.
  -- Cleanup must use the physical database clock: v_now is intentionally
  -- clamped to target-bucket time and may be far in the future after clock skew.
  v_cleanup_now := pg_catalog.clock_timestamp();
  with expired as materialized (
    select bucket.policy, bucket.dimension, bucket.subject
    from public.api_rate_limit_buckets as bucket
    where bucket.expires_at < v_cleanup_now
    order by bucket.expires_at, bucket.policy, bucket.dimension, bucket.subject
    limit 32
    for update skip locked
  )
  delete from public.api_rate_limit_buckets as bucket
  using expired
  where bucket.policy = expired.policy
    and bucket.dimension = expired.dimension
    and bucket.subject = expired.subject;

  outcome := case when v_allowed then 'allowed' else 'rate_limited' end;
  retry_after_seconds := case when v_allowed then null else v_retry end;
  reset_at := case
    when v_allowed then null
    else v_now + pg_catalog.make_interval(secs => v_retry)
  end;
  return next;
end;
$$;

create or replace function public.reserve_llm_budget(
  p_policy text,
  p_subject text,
  p_request_id uuid,
  p_reserved_tokens integer
)
returns table (
  outcome text,
  reservation_id uuid,
  reserved_tokens integer,
  retry_after_seconds integer,
  budget_date date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_started_at timestamptz := v_now;
  v_date date := public.quota_shanghai_date(v_now);
  v_next_midnight timestamptz;
  v_global_limit integer := 500000;
  v_subject_limit integer;
  v_existing public.llm_budget_reservations%rowtype;
  v_day public.llm_budget_days%rowtype;
  v_id uuid;
  v_updated integer;
begin
  if p_policy is null
    or p_subject is null
    or p_request_id is null
    or p_request_id::text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_reserved_tokens is null
    or p_reserved_tokens not between 1 and 65536 then
    raise exception 'invalid LLM budget reservation' using errcode = '22023';
  end if;

  case p_policy
    when 'web_chat' then
      if p_subject !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'invalid LLM budget reservation' using errcode = '22023';
      end if;
      v_subject_limit := 200000;
    when 'root_rank' then
      if p_subject <> 'system:ingest' then
        raise exception 'invalid LLM budget reservation' using errcode = '22023';
      end if;
      v_subject_limit := 400000;
    when 'root_summary' then
      if p_subject <> 'system:ingest' then
        raise exception 'invalid LLM budget reservation' using errcode = '22023';
      end if;
      v_subject_limit := 400000;
    when 'root_refine' then
      if p_subject <> 'system:refine' then
        raise exception 'invalid LLM budget reservation' using errcode = '22023';
      end if;
      v_subject_limit := 100000;
    else
      raise exception 'invalid LLM budget reservation' using errcode = '22023';
  end case;

  -- Day-ledger locks differ across Shanghai midnight. Serialize one logical
  -- request before its first lookup so a cross-day first-write race returns
  -- the committed reservation instead of surfacing a unique-key failure.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'frontier:llm-request:' || p_request_id::text,
      0
    )
  );

  select reservation.* into v_existing
  from public.llm_budget_reservations as reservation
  where reservation.request_id = p_request_id;
  if found then
    if v_existing.policy <> p_policy
      or v_existing.subject <> p_subject
      or v_existing.reserved_tokens <> p_reserved_tokens then
      raise exception 'invalid LLM budget reservation' using errcode = '22023';
    end if;
    outcome := 'existing';
    reservation_id := v_existing.id;
    reserved_tokens := v_existing.reserved_tokens;
    retry_after_seconds := null;
    budget_date := v_existing.budget_date;
    return next;
    return;
  end if;

  insert into public.llm_budget_days (
    budget_date, dimension, subject, token_limit,
    reserved_tokens, consumed_tokens, created_at, updated_at
  ) values
    (v_date, 'global', 'global', v_global_limit, 0, 0, v_started_at, v_started_at),
    (v_date, 'subject', p_subject, v_subject_limit, 0, 0, v_started_at, v_started_at)
  on conflict on constraint llm_budget_days_pkey do nothing;

  perform 1
  from public.llm_budget_days as day
  where day.budget_date = v_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = p_subject)
    )
  order by day.dimension, day.subject
  for update;

  select greatest(pg_catalog.clock_timestamp(), pg_catalog.max(day.updated_at))
  into strict v_now
  from public.llm_budget_days as day
  where day.budget_date = v_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = p_subject)
    );

  -- A concurrent identical request may have committed while this call waited
  -- for the shared day locks. Recheck before incrementing either counter.
  select reservation.* into v_existing
  from public.llm_budget_reservations as reservation
  where reservation.request_id = p_request_id;
  if found then
    if v_existing.policy <> p_policy
      or v_existing.subject <> p_subject
      or v_existing.reserved_tokens <> p_reserved_tokens then
      raise exception 'invalid LLM budget reservation' using errcode = '22023';
    end if;
    outcome := 'existing';
    reservation_id := v_existing.id;
    reserved_tokens := v_existing.reserved_tokens;
    retry_after_seconds := null;
    budget_date := v_existing.budget_date;
    return next;
    return;
  end if;

  select day.* into strict v_day
  from public.llm_budget_days as day
  where day.budget_date = v_date
    and day.dimension = 'global'
    and day.subject = 'global';
  if v_day.token_limit <> v_global_limit then
    raise exception 'invalid LLM budget reservation' using errcode = '22023';
  end if;
  if v_day.reserved_tokens + v_day.consumed_tokens + p_reserved_tokens > v_global_limit then
    v_next_midnight := ((v_date + 1)::timestamp at time zone 'Asia/Shanghai');
    outcome := 'budget_exhausted';
    reservation_id := null;
    reserved_tokens := null;
    retry_after_seconds := greatest(
      1,
      pg_catalog.ceil(extract(epoch from (v_next_midnight - v_now)))::integer
    );
    budget_date := v_date;
    return next;
    return;
  end if;

  select day.* into strict v_day
  from public.llm_budget_days as day
  where day.budget_date = v_date
    and day.dimension = 'subject'
    and day.subject = p_subject;
  if v_day.token_limit <> v_subject_limit then
    raise exception 'invalid LLM budget reservation' using errcode = '22023';
  end if;
  if v_day.reserved_tokens + v_day.consumed_tokens + p_reserved_tokens > v_subject_limit then
    v_next_midnight := ((v_date + 1)::timestamp at time zone 'Asia/Shanghai');
    outcome := 'budget_exhausted';
    reservation_id := null;
    reserved_tokens := null;
    retry_after_seconds := greatest(
      1,
      pg_catalog.ceil(extract(epoch from (v_next_midnight - v_now)))::integer
    );
    budget_date := v_date;
    return next;
    return;
  end if;

  update public.llm_budget_days as day
  set reserved_tokens = day.reserved_tokens + p_reserved_tokens,
      updated_at = v_now
  where day.budget_date = v_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = p_subject)
    );
  get diagnostics v_updated = row_count;
  if v_updated <> 2 then
    raise exception 'invalid LLM budget reservation' using errcode = '22023';
  end if;

  insert into public.llm_budget_reservations (
    request_id,
    policy,
    subject,
    budget_date,
    reserved_tokens,
    created_at
  ) values (
    p_request_id,
    p_policy,
    p_subject,
    v_date,
    p_reserved_tokens,
    v_started_at
  )
  returning id into strict v_id;

  outcome := 'reserved';
  reservation_id := v_id;
  reserved_tokens := p_reserved_tokens;
  retry_after_seconds := null;
  budget_date := v_date;
  return next;
end;
$$;

create or replace function public.settle_llm_budget(
  p_reservation_id uuid,
  p_subject text,
  p_actual_tokens integer
)
returns table (
  outcome text,
  charged_tokens integer,
  budget_date date
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_reservation public.llm_budget_reservations%rowtype;
  v_charged integer;
  v_usage_known boolean := p_actual_tokens is not null;
  v_updated integer;
begin
  if p_reservation_id is null or p_subject is null then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;

  select reservation.* into v_reservation
  from public.llm_budget_reservations as reservation
  where reservation.id = p_reservation_id;
  if not found or v_reservation.subject <> p_subject then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;

  v_charged := coalesce(p_actual_tokens, v_reservation.reserved_tokens);
  if v_charged not between 1 and v_reservation.reserved_tokens then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;

  -- Match reserve_llm_budget's lock order: day rows first, reservation last.
  perform 1
  from public.llm_budget_days as day
  where day.budget_date = v_reservation.budget_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = v_reservation.subject)
    )
  order by day.dimension, day.subject
  for update;

  select greatest(pg_catalog.clock_timestamp(), pg_catalog.max(day.updated_at))
  into strict v_now
  from public.llm_budget_days as day
  where day.budget_date = v_reservation.budget_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = v_reservation.subject)
    );

  select reservation.* into strict v_reservation
  from public.llm_budget_reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if v_reservation.subject <> p_subject then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;
  if v_reservation.status = 'settled' then
    if v_reservation.charged_tokens <> v_charged
      or v_reservation.usage_known <> v_usage_known then
      raise exception 'invalid LLM budget settlement' using errcode = '22023';
    end if;
    outcome := 'existing';
    charged_tokens := v_reservation.charged_tokens;
    budget_date := v_reservation.budget_date;
    return next;
    return;
  end if;
  if v_reservation.status <> 'pending' then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;

  update public.llm_budget_days as day
  set reserved_tokens = day.reserved_tokens - v_reservation.reserved_tokens,
      consumed_tokens = day.consumed_tokens + v_charged,
      updated_at = v_now
  where day.budget_date = v_reservation.budget_date
    and (
      (day.dimension = 'global' and day.subject = 'global')
      or (day.dimension = 'subject' and day.subject = v_reservation.subject)
    );
  get diagnostics v_updated = row_count;
  if v_updated <> 2 then
    raise exception 'invalid LLM budget settlement' using errcode = '22023';
  end if;

  update public.llm_budget_reservations as reservation
  set charged_tokens = v_charged,
      usage_known = v_usage_known,
      status = 'settled',
      settled_at = v_now
  where reservation.id = p_reservation_id;

  outcome := 'settled';
  charged_tokens := v_charged;
  budget_date := v_reservation.budget_date;
  return next;
end;
$$;

alter function public.consume_api_rate_limits(text, uuid, text) owner to postgres;
alter function public.quota_shanghai_date(timestamptz) owner to postgres;
alter function public.reserve_llm_budget(text, text, uuid, integer) owner to postgres;
alter function public.settle_llm_budget(uuid, text, integer) owner to postgres;

revoke all privileges on function public.consume_api_rate_limits(text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.quota_shanghai_date(timestamptz)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.reserve_llm_budget(text, text, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.settle_llm_budget(uuid, text, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.consume_api_rate_limits(text, uuid, text)
  to service_role;
grant execute on function public.reserve_llm_budget(text, text, uuid, integer)
  to service_role;
grant execute on function public.settle_llm_budget(uuid, text, integer)
  to service_role;

comment on table public.api_rate_limit_buckets is
  'Sealed database-clock token buckets shared by every Web server instance.';
comment on table public.llm_budget_days is
  'Sealed project-global and subject hard token counters keyed to Asia/Shanghai dates.';
comment on table public.llm_budget_reservations is
  'Idempotent pre-dispatch LLM token reservations and conservative settlements.';
comment on function public.consume_api_rate_limits(text, uuid, text) is
  'Atomically consumes configured owner/IP token buckets and returns a bounded Retry-After.';
comment on function public.quota_shanghai_date(timestamptz) is
  'Pure tested calendar boundary used by the hard daily LLM budget.';
comment on function public.reserve_llm_budget(text, text, uuid, integer) is
  'Atomically reserves project-global and subject LLM tokens before one provider dispatch.';
comment on function public.settle_llm_budget(uuid, text, integer) is
  'Idempotently settles actual usage, charging the reservation maximum when usage is unknown.';
