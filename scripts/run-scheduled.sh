#!/bin/zsh
set -u
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOB="${1:-}"
NODE_BIN="${2:-}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  print -u2 "scheduled job requires an absolute executable Node path"; exit 64
fi
case "$JOB" in
  deliver) COMMAND=("$NODE_BIN" --import tsx "$ROOT/scripts/delivery-worker.ts"); LOG="$ROOT/delivery.log"; ONCE_PER_SCHEDULE=0 ;;
  ingest) COMMAND=("$NODE_BIN" --import tsx "$ROOT/scripts/ingest.ts" --send); LOG="$ROOT/ingest.log"; ONCE_PER_SCHEDULE=1 ;;
  refine) COMMAND=("$NODE_BIN" --import tsx "$ROOT/scripts/refine-profile.ts"); LOG="$ROOT/refine.log"; ONCE_PER_SCHEDULE=1 ;;
  *) print -u2 "unknown scheduled job"; exit 64 ;;
esac

RUNTIME_DIR="$ROOT/.runtime"
LOCK_DIR="$RUNTIME_DIR/$JOB.lock"
MARKER="$RUNTIME_DIR/$JOB.last-success"
MARKER_TMP=""
mkdir -p "$RUNTIME_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid=""
  [[ -r "$LOCK_DIR/pid" ]] && IFS= read -r lock_pid < "$LOCK_DIR/pid"
  if [[ "$lock_pid" == <-> ]] && (( lock_pid > 1 )) && kill -0 "$lock_pid" 2>/dev/null; then
    print "[$JOB] already running; skip overlapping launchd invocation"
    exit 0
  fi
  rm -rf -- "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { print -u2 "cannot recover scheduled-job lock"; exit 1; }
fi
print -r -- "$$" > "$LOCK_DIR/pid"

cleanup() {
  [[ -n "$MARKER_TMP" ]] && rm -f -- "$MARKER_TMP"
  owner_pid=""
  [[ -r "$LOCK_DIR/pid" ]] && IFS= read -r owner_pid < "$LOCK_DIR/pid"
  [[ "$owner_pid" == "$$" ]] && rm -rf -- "$LOCK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if (( ONCE_PER_SCHEDULE )); then
  if ! SCHEDULE_TOKEN="$("$NODE_BIN" "$ROOT/scripts/schedule-token.mjs" "$JOB")"; then
    print -u2 "[$JOB] cannot determine the latest schedule occurrence"
    exit 1
  fi
  case "$SCHEDULE_TOKEN" in
    "$JOB":[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) print -u2 "[$JOB] invalid schedule occurrence"; exit 1 ;;
  esac
  if [[ -r "$MARKER" && "$(<"$MARKER")" == "$SCHEDULE_TOKEN" ]]; then
    print "[$JOB] schedule already completed ($SCHEDULE_TOKEN); skip duplicate startup/wake invocation"
    exit 0
  fi
  if [[ "$JOB" == "ingest" ]]; then
    COMMAND+=(--scheduled-date "${SCHEDULE_TOKEN#ingest:}")
  fi
fi

# Keep existing and newly created local logs private, bounded, and limited to
# the previous three rotations.
for private_log in "$LOG" "$LOG".<1-3>(N); do
  [[ -e "$private_log" ]] && chmod 600 "$private_log"
done
if [[ -f "$LOG" ]] && (( $(wc -c < "$LOG") > 5242880 )); then
  rm -f -- "$LOG.3"
  for index in 2 1; do
    [[ -f "$LOG.$index" ]] && mv -f "$LOG.$index" "${LOG}.$((index + 1))"
  done
  mv -f "$LOG" "$LOG.1"
fi
for archived in "$LOG".<4->(N); do
  rm -f -- "$archived"
done

cd "$ROOT" || exit 1
"${COMMAND[@]}" >> "$LOG" 2>&1
child_status=$?
if (( child_status != 0 )); then
  print -u2 "[$JOB] child exited with status $child_status"
  exit "$child_status"
fi

if (( ONCE_PER_SCHEDULE )); then
  MARKER_TMP="$(mktemp "$RUNTIME_DIR/.$JOB.last-success.XXXXXX")" || exit 1
  print -r -- "$SCHEDULE_TOKEN" > "$MARKER_TMP" || exit 1
  chmod 600 "$MARKER_TMP" || exit 1
  mv -f "$MARKER_TMP" "$MARKER" || exit 1
  MARKER_TMP=""
fi
