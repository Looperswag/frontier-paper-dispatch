# 配置与画像备份 / 恢复

这套备份只解决“个人画像和选源配置误删、误改”的恢复问题。它不是数据库备份，也不会复制运行密钥。

## 创建备份

```bash
npm run state:backup
```

默认写入 `.backups/state-<UTC 时间>.json`，目录权限为 `700`，文件权限为 `600`。文件已被 `.gitignore` 排除，仍应把它视为私人数据；复制到网盘或移动硬盘前应启用磁盘或文件级加密。

备份固定且仅包含：

- `config/profile.md`
- `config/sources.ts`

`.env`、`web/.env.local`、日志、数据库内容、邮件授权码和 API 密钥都不在允许清单中。指定已有输出文件也会失败，不会覆盖旧备份：

```bash
npm run state:backup -- --output /安全目录/frontier-state.json
```

## 验证与恢复

恢复默认是 dry-run，只解析清单、验证 SHA-256、大小、时间戳、路径允许清单和目标文件类型，不写磁盘：

```bash
npm run state:restore -- .backups/state-2026-07-15T12-34-56.000Z.json
```

确认输出后再创建缺失文件：

```bash
npm run state:restore -- .backups/state-2026-07-15T12-34-56.000Z.json --apply
```

如果任一目标已经存在，`--apply` 会在写入前整体失败。只有人工对比过备份内容后才使用显式覆盖：

```bash
npm run state:restore -- .backups/state-2026-07-15T12-34-56.000Z.json --apply --force
git diff -- config/sources.ts
```

恢复拒绝备份中的未知路径、重复路径、哈希不符、超限内容、符号链接目标和非当前用户文件。恢复后的两个文件权限均为 `600`。

## Supabase 数据另行保护

上述 JSON 不包含数据库导出。论文、日报、反馈、批注、问答、投递状态和运行账本都在 Supabase，必须使用当前 Supabase 套餐支持的备份/PITR，或经过验证的逻辑导出流程单独保护。数据库连接串和 service-role key 只能放在密码管理器或受保护的环境变量中，不得写入本备份、命令历史或仓库。

建议每季度做一次恢复演练：在临时目录恢复配置，运行 `npm run ingest:dry`；数据库备份则恢复到隔离项目，执行迁移/完整性测试，并确认行数与最近日报。当前仓库没有自动上传备份或自动数据库恢复功能，因此没有可承诺的 RPO/RTO；备份频率和恢复演练仍是运行责任。
