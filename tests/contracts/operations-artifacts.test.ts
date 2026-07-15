import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("disaster recovery artifacts", () => {
  test("exposes safe backup and dry-run restore commands outside version control", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["state:backup"]).toContain("state-backup.ts backup");
    expect(pkg.scripts["state:restore"]).toContain("state-backup.ts restore");
    expect(readFileSync(".gitignore", "utf8")).toContain(".backups/");

    const doc = readFileSync("docs/operations/backup-restore.md", "utf8");
    expect(doc).toContain("dry-run");
    expect(doc).toContain("--apply");
    expect(doc).toContain("--force");
    expect(doc).toContain(".env");
    expect(doc).toContain("Supabase");
  });
});

describe("privacy and observability boundaries", () => {
  test("documents current retention, disclosures, export and deletion limits", () => {
    const privacy = readFileSync("docs/privacy-data-lifecycle.md", "utf8");
    for (const expected of [
      "当前没有自动保留期清理",
      "DeepSeek",
      "Supabase",
      "Server酱",
      "SMTP",
      "告警 Webhook",
      "不包含数据库导出",
      "一键删除",
    ]) {
      expect(privacy).toContain(expected);
    }
  });

  test("provides a concrete monitoring runbook without claiming an external service is configured", () => {
    const monitoring = readFileSync("docs/operations/monitoring.md", "utf8");
    for (const expected of [
      "npm run doctor",
      "pipeline_runs",
      "source_runs",
      "23:30",
      "delivery_alerts",
      "ALERT_WEBHOOK_URL",
      "运行态阻塞",
    ]) {
      expect(monitoring).toContain(expected);
    }
  });
});

describe("disabled cloud schedule", () => {
  test("is gated by a repository variable and preserves database-level concurrency", () => {
    const workflow = readFileSync(".github/workflows/scheduled-ingest.yml", "utf8");
    for (const expected of [
      "15 14 * * *",
      "vars.ENABLE_CLOUD_INGEST == 'true'",
      "persist-credentials: false",
      "concurrency:",
      "npm run cloud:materialize",
      "npm run preflight -- --target ingest:send",
      "npm run ingest:send",
      "secrets.PROFILE_MD",
      "secrets.SUPABASE_SERVICE_ROLE_KEY",
      "secrets.ALERT_WEBHOOK_URL",
    ]) {
      expect(workflow).toContain(expected);
    }

    const doc = readFileSync("docs/operations/cloud-scheduling.md", "utf8");
    for (const expected of [
      "默认禁用",
      "ENABLE_CLOUD_INGEST",
      "数据库租约",
      "本地与云端",
      "15 分钟投递 worker",
      "GitHub Actions Secrets",
    ]) {
      expect(doc).toContain(expected);
    }
  });
});
