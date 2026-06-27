# 前沿论文情报台

多源采集（arxiv / huggingface / github / 大厂 blog；X best-effort）→ DeepSeek 依据你的画像排名 Top5、写概要与「对我的影响」→ 每晚十点推送到微信（Server酱）。复古牛皮纸阅读前台（批注 / chatbot / 导出）见 Phase 2+（`SPEC.md`）。

## 快速开始

```bash
cd "平台"
npm install

# 1) 零配置实时试跑：抓真实候选、去重、打印预览（不写库、不发信）
npm run ingest:dry

# 2) 跑单测（normalize / dedupe）
npm test
```

## 接入完整流水线

1. 复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SERVERCHAN_SENDKEY`（微信推送）。
2. 在 Supabase SQL Editor 执行 `supabase/migrations/0001_init.sql`。
3. 编辑 `config/profile.md`（你的角色 / 在做的项目 / 关注方向）——排名和影响都基于它。
4. 写库不发信：`npm run ingest`；写库并发信：`npm run ingest:send`。
5. 装每晚 21:45 定时（改 plist 里的绝对路径后）：
   ```bash
   cp launchd/com.frontierpapers.ingest.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.frontierpapers.ingest.plist
   ```

## Web 前台（Phase 2，复古牛皮纸阅读 UI）
```bash
cd web
npm install
# web/.env.local 需含 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY（可从 ../.env 复制）
npm run dev          # 打开 http://localhost:3000
```
三栏布局：左=归档列表，中=牛皮纸纸张阅读器（首页是每日电讯 Top5 封面，点进是单篇概要+影响），右 1/3=电报问询（Phase 3 接入）。
要随处访问：`vercel deploy`，并在 Vercel 项目里配 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`DEEPSEEK_API_KEY` 三个环境变量。

> ⚠️ **部署前必读（鉴权）**：本应用目前**无内置登录**，`/api/chat` 会调用 DeepSeek（花钱）。公开部署 = 任何人拿到 URL 都能看你的简报、烧你的 DeepSeek 额度。部署到 Vercel 时**务必开启 Deployment Protection**（Settings → Deployment Protection → Vercel Authentication 或 Password），平台层一键挡住全站含 API，零代码。完整的单用户登录（Supabase Auth 邮箱白名单）排在 Phase 5。本地 `npm run dev` 不对外暴露，无此风险。

## 结构
```
config/    sources.ts（源+权重）  profile.md（你的画像）
lib/       types / normalize(+test) / http / claude / supabase
scripts/   ingest.ts（入口）  rank / summarize / digest  fetchers/*
supabase/  migrations/0001_init.sql
launchd/   夜跑 plist
```

## 配置源
改 `config/sources.ts`：arxiv 分类、github 主题、blog RSS 列表、每源上限、回看天数。失效的 blog feed 会被静默跳过。
