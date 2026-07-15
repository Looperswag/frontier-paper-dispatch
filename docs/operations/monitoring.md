# 运行监控与故障处理

## 每次部署或修改密钥后

```bash
npm run doctor
npm run preflight -- --target ingest:send
```

`doctor` 必须确认仓库位置、Node 版本、锁文件、`.env` 权限、3 个 LaunchAgent 模板、完整推送配置和独立告警。`ALERT_WEBHOOK_URL` 对手工采集不是必需，但缺失会让 `doctor` 和 launchd 安装失败，对无人值守任务属于运行态阻塞：任务仍可把告警保留为可重试，却无法把本机或投递通道故障发送到外部。

## 每日检查点（Asia/Shanghai）

| 时间 | 应看到的状态 | 证据 |
| --- | --- | --- |
| 22:00 后 | 当日采集开始且仅一位 worker 获得租约 | `pipeline_runs`、`ingest.log` |
| 采集完成后 | 各来源有 succeeded/empty/failed 记录 | `source_runs` |
| 23:30 前 | 当日日报至少成功投递到微信；配置 SMTP 时邮件也成功 | `get_delivery_health('YYYY-MM-DD')` |
| 23:30 后 | 缺失渠道产生一次可租约、可重试的告警 | `delivery_alerts`、`delivery.log`、外部 Webhook |

GitHub Actions 的完成时间和 LaunchAgent 日历时间不是可用性证明；数据库账本才是本地与云端共享的事实来源。

## Supabase 检查

以下查询在 Supabase SQL Editor 以管理员身份执行，并把日期替换成上海日历日；不要把结果贴到公开 issue：

```sql
select id, run_date, status, candidate_count, source_count,
       started_at, heartbeat_at, finished_at, error_message
from public.pipeline_runs
order by run_date desc, started_at desc
limit 14;

select source, status, item_count, error_message, started_at, finished_at
from public.source_runs
where run_id = '<pipeline run uuid>'
order by source;

select * from public.get_delivery_health('YYYY-MM-DD');

select alert_date, alert_key, status, attempts, last_error, sent_at
from public.delivery_alerts
order by alert_date desc, alert_key;
```

这些表/RPC 对浏览器角色不可见；SQL Editor 输出可能包含运营细节。`running` 的心跳超过 6 小时未更新后，数据库才允许下一次任务用新 UUID 接管；旧 attempt 会保留为 `failed`，其来源记录也不会删除。旧 UUID 此后不能写来源、日报或投递。不要通过手改状态或删除账本“解锁”。

## 处置顺序

1. 先保存 correlation ID、日期和安全化错误，不复制 `.env` 或完整 provider 响应。
2. 运行 `npm run doctor`；配置失败先修配置，不反复启动任务。
3. 单一来源失败时查看 `source_runs` 与对应官方状态；多来源失败时先检查网络、DNS 和上游限流。
4. 投递处于 pending/retry 时保留 15 分钟 delivery worker 重试；failed 或达到永久失败门槛时检查 Server酱/SMTP 凭证和供应商状态，修复后用 `npm run push:last` 只重置最近有效简报的失败渠道。
5. `delivery_alerts` 为 pending 表示独立告警尚未送达；确认 `ALERT_WEBHOOK_URL` 后让下一轮 worker 重新 claim，不直接把状态改成 succeeded。
6. 修复后用数据库账本确认，不以“命令退出 0”单独结案。

当前和轮转日志均应为 mode `0600`，且采集日志不写反馈正文。当前仓库也没有自动值班升级；独立 Webhook、Supabase 平台告警和接收人仍需在真实运行环境中配置并实测。
