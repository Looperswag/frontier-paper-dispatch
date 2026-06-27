# 任务计划

## Phase 1 — 数据骨架（当前里程碑）
- [x] 项目脚手架（package.json / tsconfig / .gitignore / .env.example）
- [x] 数据模型 SQL（supabase/migrations/0001_init.sql）
- [x] 归一化 + 去重（lib/normalize.ts）+ 单测（lib/normalize.test.ts）
- [x] fetchers：arxiv / huggingface / github / blogs（x 为 Phase5 桩）
- [x] Claude 排名（scripts/rank.ts）
- [x] Claude 概要 + 影响（scripts/summarize.ts）
- [x] digest 渲染 + Resend 邮件（scripts/digest.ts）
- [x] orchestrator + --dry / --send（scripts/ingest.ts）
- [x] launchd 夜跑（launchd/com.frontierpapers.ingest.plist）
- [x] 验证：`npm test` 通过 + `npm run ingest:dry` 实时抓到真实候选
- [ ] 用户接入：填 .env（Anthropic/Supabase/Resend）→ 跑 Supabase 迁移 → `npm run ingest:send` 收信 → 装 launchd

## Phase 2 — 复古阅读 UI（next）
- [ ] web/ 子应用：Next.js App Router 部署 Vercel，读 Supabase
- [ ] 三栏布局 + 牛皮纸「纸张」阅读器（固定宽）+ 论文列表

## Phase 3 — chatbot
- [ ] 右栏面板：单篇满上下文问答，写 chats 表

## Phase 4 — 批注 + 导出
- [ ] 高亮/便签（文本锚定）+ 画笔/框选（SVG 叠层，归一化坐标）
- [ ] 导出 md / pdf（打印 CSS）/ word（docx）

## Phase 5 — 增强
- [ ] X 源（agent-reach）+ FB 可选
- [ ] Voyage 嵌入 + pgvector 跨库检索
- [ ] 画像从批注/chat 自动精炼
