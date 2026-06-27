# 任务计划

## Phase 1 — 数据骨架（当前里程碑）
- [x] 项目脚手架（package.json / tsconfig / .gitignore / .env.example）
- [x] 数据模型 SQL（supabase/migrations/0001_init.sql）
- [x] 归一化 + 去重（lib/normalize.ts）+ 单测（lib/normalize.test.ts）
- [x] fetchers：arxiv / huggingface / github / blogs（x 为 Phase5 桩）
- [x] Claude 排名（scripts/rank.ts）
- [x] Claude 概要 + 影响（scripts/summarize.ts）
- [x] digest 渲染 + Server酱 微信推送（scripts/digest.ts）
- [x] orchestrator + --dry / --send（scripts/ingest.ts）
- [x] launchd 夜跑（launchd/com.frontierpapers.ingest.plist）
- [x] 验证：`npm test` 通过 + `npm run ingest:dry` 实时抓到真实候选
- [ ] 用户接入：填 .env（DeepSeek/Supabase/Server酱）→ 跑 Supabase 迁移 → `npm run ingest:send` 收到微信推送 → 装 launchd

## Phase 2 — 复古阅读 UI ✅
- [x] web/ 子应用：Next.js 16 App Router，读 Supabase（service role，仅服务端）
- [x] 三栏布局（左 归档 / 中 牛皮纸纸张固定 720px / 右 1/3 电报问询）
- [x] 牛皮纸阅读器：装订孔 + 双线边框 + 火漆红印章 + 打字机字体 + 霉斑做旧
- [x] 首页 digest 封面（每日电讯 + Top5 目录）+ 单篇阅读页（概要/影响，markdown 已清洗）
- [x] 验证：dev 200、截图核对观感；md 经 sanitize-html 防 XSS
- [ ] 用户接入：`cd web && npm run dev` 看本地；要随处访问再 `vercel deploy`（设 SUPABASE_URL/KEY 环境变量）

## Phase 3 — chatbot ✅
- [x] 右栏电报面板：基于本篇（原文+概要+影响）满上下文问答，DeepSeek 流式输出
- [x] /api/chat：POST 流式 + GET 历史；两端落库 chats；切换论文自动载入历史
- [x] 验证：curl 实测流式答案 paper-grounded（引用用户导购产品）+ 落库 + web tsc 干净

## Phase 4 — 批注 + 导出 ✅
- [x] 统一坐标模型：高亮(选区client-rects)/便签(点)/画笔(点串)/框选(矩形) 全部纸张相对坐标，SVG 叠层
- [x] 工具栏（选/高亮/便签/画笔/框选/擦 + 4 色）+ 持久化 /api/annotations(GET/POST/DELETE，含校验)
- [x] 导出 md（/api/export）+ word（docx 库）+ pdf（打印 CSS + window.print）
- [x] 验证：CRUD/非法 type 400/MD 内容/Word 真 docx/页面工具栏 全部 curl 实测通过

## Phase 5 — 增强（进行中）
- [x] 跨库检索：Postgres/JS 关键词检索（标题/摘要/概要/影响，AND 多词，中英通）+ 左栏搜索框 + /search 页（DeepSeek 无 embeddings，故先关键词，向量留待有 Voyage key）
- [x] 鉴权（临时）：middleware Basic Auth 口令门（Vercel 免费版生产无官方保护）；正式 Supabase Auth 登录待办
- [~] X 源：agent-reach 已装但 twitter 后端需 `pipx install twitter-cli` + 授权；x.ts 留好接入点与步骤，启用后 shell out twitter-cli
- [ ] Voyage 嵌入 + pgvector 语义检索（需 embedding key）
- [ ] 画像从批注/chat 自动精炼（DeepSeek 可做，待办）
- [ ] 正式 Supabase Auth 登录 + 写接口归属校验
