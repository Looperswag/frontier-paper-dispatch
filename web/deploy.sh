#!/usr/bin/env bash
# 一键部署到 Vercel。
# 前提：先在本目录跑过 `npx vercel login`（交互，浏览器确认）。
# 用法：cd web && bash deploy.sh
set -e
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "✗ 缺 web/.env.local（需含 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DEEPSEEK_API_KEY）"; exit 1
fi

echo "→ 关联 Vercel 项目（首次会问几个问题，可一路默认）"
npx vercel link --yes

echo "→ 把 3 个环境变量写入 production"
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY DEEPSEEK_API_KEY; do
  v=$(grep -E "^$k=" .env.local | cut -d= -f2-)
  if [ -n "$v" ]; then
    npx vercel env rm "$k" production -y >/dev/null 2>&1 || true
    printf '%s' "$v" | npx vercel env add "$k" production >/dev/null
    echo "   ✓ $k"
  else
    echo "   ⚠ $k 在 .env.local 里为空，跳过"
  fi
done

echo "→ 部署到生产"
npx vercel --prod

cat <<'NOTE'

✅ 部署完成。
⚠️ 安全：现在务必去 vercel.com → 该项目 → Settings → Deployment Protection
   开启 Vercel Authentication（或设密码）。否则全站含所有 API 对公网开放，
   任何人拿到 URL 都能看你的简报、改你的批注、烧你的 DeepSeek 额度。
   （应用内登录 = Phase 5。）
NOTE
