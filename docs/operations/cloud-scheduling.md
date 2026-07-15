# GitHub Actions 云端定时任务

`.github/workflows/scheduled-ingest.yml` 是可复制的每日 cron，但默认禁用。工作流会按 `15 14 * * *`（UTC，即上海 22:15）触发；只有仓库变量 `ENABLE_CLOUD_INGEST` 的值严格等于 `true` 时 job 才会读取 secrets 和执行。

## 启用前

在 GitHub Actions Secrets 配置：

- 必需：`PROFILE_MD`、`DEEPSEEK_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SERVERCHAN_SENDKEY`、`WEB_BASE_URL`、`FEEDBACK_SECRET`、`ALERT_WEBHOOK_URL`
- 稳定启用 OpenAlex 时建议：`OPENALEX_API_KEY`（配置校验可选；缺失时 OpenAlex 可能单独降级）
- 告警鉴权可选：`ALERT_WEBHOOK_TOKEN`
- 邮件双通道可选但必须成套：`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`EMAIL_FROM`、`EMAIL_TO`

GitHub API 使用工作流自动签发、只读权限的 `github.token`，不需要另建长期 `GITHUB_TOKEN`。`PROFILE_MD` 使用多行 secret。工作流把严格允许清单写成 mode `600` 的临时 `.env` 和 `config/profile.md`，先跑 preflight，结束时删除；任何已有文件都会导致失败而不是覆盖。

随后在 Actions Variables 新建 `ENABLE_CLOUD_INGEST=true`。建议先手动触发一次并核对数据库账本，再保留 cron。删除变量或设为其他值即可恢复默认禁用。`ALERT_WEBHOOK_URL` 对手工本地命令是可选能力，但云 materializer 会强制要求它，避免无人值守失败只能依赖已故障的投递渠道。

## 本地与云端并发

GitHub `concurrency` 只防止同一仓库的两个云 job 重叠，不能看到个人 Mac 上的 LaunchAgent。真正跨本地与云端的防线是 Supabase `start_pipeline_run` 数据库租约：同一上海日期的成功任务不会重跑，正在运行且未超过 6 小时的任务也不会被另一端接管。

即使有数据库租约，也不建议长期同时启用本地与云端定时器；两边仍会在获得租约前读取密钥、启动 runner，并可能让故障判断变复杂。迁移时保留一端，验证后再停另一端。不要通过删除 `pipeline_runs` 来解决并发。

## 不覆盖的能力

这个 cron 只运行每日 `ingest:send`。它不替代本地每 15 分钟投递 worker，也不提供 23:30 截止告警的持续调度；纯云部署必须另外选择可持续运行的调度器来执行 `npm run delivery:work`，并验证独立 Webhook。GitHub 定时任务可能延迟，不能作为精确截止时间机制。

工作流也不部署 Web、不开启 Supabase 备份、不自动轮换 GitHub Actions Secrets。缺少真实 GitHub/Supabase/DeepSeek/推送凭证时，仓库只完成代码闭环，云端运行仍是明确阻塞。
