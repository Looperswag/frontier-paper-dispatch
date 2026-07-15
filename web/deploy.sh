#!/usr/bin/env bash
# Preflighted Vercel production deployment. Run after `npx vercel login`.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$WEB_DIR/.." && pwd)"
ENV_FILE="${WEB_ENV_FILE:-$WEB_DIR/.env.local}"
ROOT_ENV_FILE="${ROOT_ENV_FILE:-$ROOT/.env}"
SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontier-web-env.XXXXXX")"
SNAPSHOT="$SNAPSHOT_DIR/.env.snapshot"
cleanup() {
  rm -f "$SNAPSHOT"
  rmdir "$SNAPSHOT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Read once through O_NOFOLLOW, validate owner/mode, and deploy exactly this snapshot.
(cd "$ROOT" && node --import tsx scripts/snapshot-env.ts "$ENV_FILE" "$SNAPSHOT")

# Validate the secure Root issuer configuration against the exact Web snapshot
# before `vercel link` or any remote mutation.
(cd "$ROOT" && npm run preflight -- \
  --target all \
  --root-env "$ROOT_ENV_FILE" \
  --web-env "$SNAPSHOT")

cd "$WEB_DIR"
echo "→ 关联 Vercel 项目（首次会提示确认）"
npx vercel link --yes

KEYS=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_PUBLISHABLE_KEY
  AUTH_OWNER_EMAIL
  DEEPSEEK_API_KEY
  WEB_BASE_URL
  FEEDBACK_SECRET
  RATE_LIMIT_SECRET
  RATE_LIMIT_SECRET_VERSION
)
REMOVE_ONLY_KEYS=(
  APP_PASSWORD
  NEXT_PUBLIC_DEMO_MODE
)

remote_key_exists() {
  local key="$1"
  local listing
  if ! listing="$(npx vercel env ls production --no-color)"; then
    echo "无法读取 Vercel production 环境变量列表；已停止部署。" >&2
    return 2
  fi
  printf '%s\n' "$listing" | awk -v key="$key" '$1 == key { found=1 } END { exit(found ? 0 : 1) }'
}

remove_remote_key_if_present() {
  local key="$1"
  local status
  if remote_key_exists "$key"; then
    npx vercel env rm "$key" production -y >/dev/null
  else
    status=$?
    if [[ "$status" -ne 1 ]]; then return "$status"; fi
    return 0
  fi

  if remote_key_exists "$key"; then
    echo "Vercel production 环境变量 $key 删除后仍存在；已停止部署。" >&2
    return 1
  else
    status=$?
    if [[ "$status" -ne 1 ]]; then return "$status"; fi
  fi
}

echo "→ 清除已废弃的 production 环境变量"
for key in "${REMOVE_ONLY_KEYS[@]}"; do
  remove_remote_key_if_present "$key"
  echo "   − $key"
done

echo "→ 同步经过白名单的 production 环境变量"
for key in "${KEYS[@]}"; do
  value="$(cd "$ROOT" && node --import tsx scripts/read-env-value.ts "$SNAPSHOT" "$key")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value" | npx vercel env add "$key" production --force >/dev/null
    echo "   ✓ $key"
  else
    remove_remote_key_if_present "$key"
    echo "   − ${key}（未配置，已清除远端旧值）"
  fi
done

echo "→ 部署到生产"
npx vercel --prod --yes

echo "✅ 部署完成；Proxy 刷新与页面/DAL/API owner 授权已启用。"
