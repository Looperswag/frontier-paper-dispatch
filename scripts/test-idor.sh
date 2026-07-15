#!/usr/bin/env bash
set -euo pipefail
export SUPABASE_TELEMETRY_DISABLED=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE="$ROOT/node_modules/.bin/supabase"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_frontier-paper-dispatch}"
LOCK_DIR="${TMPDIR:-/tmp}/${DB_CONTAINER}.test.lock"
STARTED_HERE=0
RESET_COMPLETED=0
LOCK_HELD=0
STATUS_FILE=""

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
  chmod 600 "$LOCK_DIR/pid"
  LOCK_HELD=1
}

cleanup() {
  if [[ -n "$STATUS_FILE" ]]; then
    rm -f "$STATUS_FILE"
  fi
  if [[ "$STARTED_HERE" == "1" ]]; then
    "$SUPABASE" stop --no-backup >/dev/null 2>&1 || true
  elif [[ "$RESET_COMPLETED" == "1" ]]; then
    "$SUPABASE" db reset --local >/dev/null 2>&1 || true
  fi
  if [[ "$LOCK_HELD" == "1" ]]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

status_value() {
  node - "$STATUS_FILE" "$1" <<'NODE'
const fs = require("node:fs");
const [file, requested] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(file, "utf8"));
const aliases = {
  ANON_KEY: ["ANON_KEY", "anon_key"],
  API_URL: ["API_URL", "api_url"],
  JWT_SECRET: ["JWT_SECRET", "jwt_secret"],
  SERVICE_ROLE_KEY: ["SERVICE_ROLE_KEY", "service_role_key"],
};
const value = aliases[requested]?.map((key) => status[key]).find(
  (candidate) => typeof candidate === "string" && candidate.length > 0,
);
if (!value) process.exit(1);
process.stdout.write(value);
NODE
}

trap cleanup EXIT
acquire_lock

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
fi

if ! "$SUPABASE" start \
  -x edge-runtime,imgproxy,logflare,mailpit,postgres-meta,realtime,storage-api,studio,supavisor,vector \
  >/dev/null 2>&1; then
  printf 'Could not start the isolated local Supabase authorization stack.\n' >&2
  exit 1
fi
if ! "$SUPABASE" db reset --local >/dev/null 2>&1; then
  printf 'Could not reset the isolated local Supabase authorization database.\n' >&2
  exit 1
fi
RESET_COMPLETED=1

umask 077
STATUS_FILE="$(mktemp "${TMPDIR:-/tmp}/frontier-idor-status.XXXXXX")"
if ! "$SUPABASE" status -o json > "$STATUS_FILE" 2>/dev/null; then
  printf 'Could not read the isolated local Supabase status.\n' >&2
  exit 1
fi

export SUPABASE_URL="$(status_value API_URL)"
export SUPABASE_PUBLISHABLE_KEY="$(status_value ANON_KEY)"
export SUPABASE_SERVICE_ROLE_KEY="$(status_value SERVICE_ROLE_KEY)"
export IDOR_JWT_SECRET="$(status_value JWT_SECRET)"
export SUPABASE_DB_CONTAINER="$DB_CONTAINER"

AUTH_READY=0
for _attempt in {1..30}; do
  if curl --fail --silent --max-time 2 "$SUPABASE_URL/auth/v1/health" >/dev/null; then
    AUTH_READY=1
    break
  fi
  sleep 1
done
if [[ "$AUTH_READY" != "1" ]]; then
  printf 'The isolated local Supabase Auth service did not become ready.\n' >&2
  exit 1
fi

npm --prefix "$ROOT/web" run test:e2e:idor
