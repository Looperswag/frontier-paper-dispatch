# Frontier Paper Dispatch Web

Next.js 16 私有阅读端：显示最近简报和最近 60 篇有摘要项目的归档，并在最近最多 500 篇的标题、abstract、一句话、概要和影响中做 AND 关键词子串检索；另支持反馈、批注、单篇问答，以及 Markdown、Word 和浏览器打印 PDF。页面展示的是已存摘要或来源 abstract，不抓取论文全文，也不做跨库 RAG。

## 本地运行

先在仓库根目录安装两套依赖：

```bash
npm ci
npm --prefix web ci
cp web/.env.example web/.env.local
chmod 600 web/.env.local
npm --prefix web run dev
```

`.env.local` 必须包含：

- `SUPABASE_URL`、server-only 的 `SUPABASE_SERVICE_ROLE_KEY` 和 `SUPABASE_PUBLISHABLE_KEY`
- 已在 Supabase Auth 预创建并确认的 `AUTH_OWNER_EMAIL`
- server-only 的 `DEEPSEEK_API_KEY`
- 与根目录 `.env` 完全一致的 `WEB_BASE_URL`、`FEEDBACK_SECRET`
- server-only 的 `RATE_LIMIT_SECRET`（至少 32 字节随机值）和 `RATE_LIMIT_SECRET_VERSION`（正整数）

本地运行时 `WEB_BASE_URL` 可设为 `http://127.0.0.1:3000`；生产环境填写最终 HTTPS origin，不能带路径、查询或 fragment。owner 密码只输入 `/login`，不要写入文件或云环境变量。Supabase Auth 应关闭公开注册和匿名登录。

## 安全边界

- Proxy 刷新会话并拒绝明显的匿名访问；私有 layout、页面、每个 API 和 LLM capability 会验证唯一 owner。数据层只接受已授权 capability 并使用 service-role 访问当前单 owner 数据，不提供多租户行级隔离。
- 状态变更请求执行同源检查、严格 schema 和请求体上限；错误响应不暴露上游细节。
- publishable key 仅用于 Auth；service-role、DeepSeek 和反馈密钥只在 server-only 模块读取。
- 简报中的反馈链接先进入只读确认页，owner 确认后才原子兑换一次性 token。
- 当前没有匿名演示。

## 验证与部署

```bash
npm --prefix web run verify
npm --prefix web run verify:full
cd web && bash deploy.sh
```

`deploy.sh` 在任何 Vercel 远端变更前，将 Web 环境快照与根目录 `.env` 执行完整一致性 preflight，并只同步白名单变量。完整预检也要求根目录配置 `SERVERCHAN_SENDKEY`；根环境文件不在默认位置时设置 `ROOT_ENV_FILE=/绝对路径/.env`。部署后用无痕窗口验证匿名 `/` 跳到 `/login`、匿名 API 返回 401、owner 可登录，以及退出后再次被拒绝。
