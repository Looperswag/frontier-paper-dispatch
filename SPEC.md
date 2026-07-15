# Frontier Paper Dispatch — 产品与安全约定

## 目标

每天从可信公开源收集 AI/ML 候选内容，按单个用户的画像和反馈选出 Top 5，生成摘要与“对你的影响”，保存到 Supabase，并可推送到微信。Next.js 阅读端用于检索、阅读、反馈、批注、单篇问答和导出。

## 系统边界

- 本地 Node.js 任务负责采集、去重、DeepSeek 排名/总结、数据库写入，以及通过服务端 outbox 投递 Server酱；配置完整 SMTP 后同时投递 multipart 邮件。
- macOS launchd 默认每天 22:00 运行采集，每周日 23:00 运行画像精炼命令；信号不足时不会生成建议文件。
- Vercel 上的 Next.js 应用读取同一 Supabase，仅服务一个预创建且已确认的 owner。
- 当前源为 arXiv、Hugging Face Daily Papers、GitHub Repository Search 和精选官方博客 feed。X/Facebook、PDF 全文、向量检索/RAG 不在当前实现范围；邮件投递需显式配置 SMTP。

## 采集与简报约定

1. 各来源并行、独立失败；成功结果经过 URL/外部 ID 规范化与去重。
2. arXiv 分类采用同一次官方 feed 请求，并在分类间轮转取样，避免高流量分类挤占候选池。
3. dry-run 只展示候选，不调用 LLM、不写库、不推送。
4. 非 dry-run 先写候选，再结合画像与近期反馈排名 Top 5；摘要和每日简报通过同一个 service-role-only 数据库事务保存，任一步失败全部回滚。
5. 每日简报快照一旦建立，Top 5、Markdown 和日期不可变；同日重跑只有摘要与快照都完全一致时才是无写入的成功，不同结果必须失败且不得改写摘要。已有更新日期时，迟到的旧日期任务在判断同日重复前失败，不能触发过期投递。仅投递时间可以由后续专用投递流程更新。
6. 简报反馈链接为有期限、一次性、带 HMAC 的 token。打开链接只验证和展示，owner 明确确认后才以数据库事务原子兑换。
7. 重新推送只允许当前 origin、当前密钥、未过期且与已存日期/项目顺序完全一致的链接。

## Web 功能约定

- 首页以单条数据库语句的一致快照读取最近一份简报、Top 5、摘要和反馈状态。
- 左栏归档展示最近 60 篇有摘要的项目；检索在最近最多 500 篇的标题、abstract、一句话、概要和影响中做 AND 子串匹配，不宣称全文或语义检索。
- 单篇页展示存储的摘要；没有摘要时回退到来源 abstract，不抓取论文 PDF 正文。
- 问答主要基于该篇已存信息，也可结合模型已有知识；未覆盖内容应标为推测，不使用跨库 RAG。
- 批注支持高亮、便签、画笔和框选并持久化。
- 服务端导出 Markdown/Word；PDF 使用浏览器打印。
- 信号合计至少 3 条时，`refine` 生成画像建议但不覆盖画像；存在反馈时才生成选源建议。`refine:apply` 会重新生成并应用本次画像结果，而不是直接套用旧建议；选源建议始终人工应用。

## 数据模型

核心表为 `items`、`summaries`、`digest_items`、`digests`、`feedback`、`annotations`、`chats`、`feedback_token_redemptions`，以及服务端专用的 `delivery_outbox`、`pipeline_runs`、`source_runs` 和 `summary_versions`。数据库的最终定义与权限以 `supabase/migrations/` 中按顺序执行的全部 migration 为准。

## 鉴权与密钥约定

- Supabase Auth 中只预创建一个已确认 owner，并关闭公开 signup 和 anonymous provider。
- `/login` 只接收 owner 密码；密码不进入 `.env`、Vercel 或仓库。
- 匿名私有页面跳转到 `/login`，匿名业务 API 返回 401。旧式共享口令不具有权限。
- Proxy 只负责会话刷新和早期筛选；私有 layout、页面、API、数据层和 LLM capability 各自重新验证 owner。
- 状态变更 API 要求同源请求、严格 schema、有限请求体和固定错误响应。
- service-role、DeepSeek 和反馈密钥不得带 `NEXT_PUBLIC_` 前缀，也不得在日志或错误中回显。
- 当前不提供匿名演示。未来若提供，必须使用与私有 Supabase、service-role、LLM、聊天和批注完全隔离的 fixture 环境。

## 验收

```bash
npm run ingest:dry
npm run verify:full
npm run db:test
```

配置真实密钥后，还需验证 `npm run ingest` 写库、`npm run ingest:send` 收到微信、无痕窗口匿名拒绝、owner 登录/退出，以及 launchd 手工触发日志。

来源健康状态、独立失败告警、自动保留期限和整库删除入口尚未实现，不应由文档或界面暗示已具备。新鲜度门禁、投递 outbox/租约/幂等重试和 SMTP 邮件已实现，但仍需配置真实 canary 才能证明外部收件成功。
