# SPEC — 前沿论文情报台

## 目标
自动采集 arxiv / huggingface / github / 大厂官方 blog（X best-effort，FB 可选），用 Claude 依据「我的画像」排名 Top5、生成概要与「对我的影响」，每晚十点邮件推送；并提供复古牛皮纸阅读前台（批注 + 右栏 chatbot + md/pdf/word 导出）。

## 架构
混合部署：**本地 Mac**（launchd 夜跑）采集+排名+总结+发信，写入**共享 Supabase**；**云端 Vercel** 的 Next.js 阅读 UI 读同一库。一个仓库两入口。

## 数据模型
`items`（去重键 source+external_id）/ `summaries` / `digests` / `annotations` / `chats` / `embeddings`(Phase5)。见 `supabase/migrations/0001_init.sql`。

## 模型
DeepSeek（OpenAI 兼容）：排名 + 概要 + 影响均用 `deepseek-chat`（DeepSeek-V3）。嵌入（Phase5）可用 DeepSeek 暂无的话走 Voyage/本地模型。

## 阶段
- **Phase 1（本仓库当前范围）**：采集 + 排名 + 总结/影响 + 每日 digest + Resend 邮件 + launchd。
- **Phase 2**：Next.js 部署 Vercel + 三栏布局 + 牛皮纸阅读器 + 列表。
- **Phase 3**：右栏 chatbot（单篇满上下文问答，不做 RAG）。
- **Phase 4**：批注层（高亮/便签/画笔/框选，持久化）+ md/pdf/word 导出。
- **Phase 5**：X 源（agent-reach）+ FB 可选 + Voyage 嵌入 + 跨库检索 + 画像自动精炼。

## Phase 1 验收
1. `npm run ingest:dry` 实时抓到 arxiv/HF/github/blog 真实候选，去重后打印预览（无需任何密钥）。
2. `npm test` 通过（normalize/dedupe 单测）。
3. 配好 `.env` 后 `npm run ingest` 写入 Supabase；`npm run ingest:send` 收到 Top5 邮件。
4. launchd plist 装载后能自动夜跑一轮。

## 明确简化（ponytail，到点再加）
单篇问答不做 RAG（满上下文）；PDF 先打印 CSS；鉴权单用户邮箱白名单；FB 默认跳过、X best-effort。
