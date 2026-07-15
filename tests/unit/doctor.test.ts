import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  isShanghaiTimeZone,
  isTCCProtectedPath,
  runDoctor,
  supportedNodeVersion,
} from "../../scripts/doctor.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("doctor accepts the documented Node range and rejects unsupported runtimes", () => {
  expect(supportedNodeVersion("20.19.0")).toBe(true);
  expect(supportedNodeVersion("24.0.0")).toBe(true);
  expect(supportedNodeVersion("20.18.9")).toBe(false);
  expect(supportedNodeVersion("26.0.0")).toBe(false);
  expect(supportedNodeVersion("garbage")).toBe(false);
});

test("doctor recognizes macOS privacy-protected project locations", () => {
  expect(isTCCProtectedPath("/Users/test/Desktop/frontier-paper-dispatch", "/Users/test")).toBe(true);
  expect(isTCCProtectedPath("/Users/test/Documents/project", "/Users/test")).toBe(true);
  expect(isTCCProtectedPath("/Users/test/Projects/frontier-paper-dispatch", "/Users/test")).toBe(false);
});

test("doctor requires the Shanghai wall-clock used by launchd schedules", () => {
  expect(isShanghaiTimeZone("Asia/Shanghai")).toBe(true);
  expect(isShanghaiTimeZone("UTC")).toBe(false);
  expect(isShanghaiTimeZone("America/Los_Angeles")).toBe(false);
});

test("doctor validates all three schedules, full send config, and an independent alert", async () => {
  const parent = mkdtempSync(join(tmpdir(), "frontier-doctor-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "frontier-paper-dispatch");
  mkdirSync(join(root, "launchd"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web/package-lock.json"), "{}\n");
  for (const job of ["deliver", "ingest", "refine"]) {
    writeFileSync(
      join(root, `launchd/com.frontierpapers.${job}.plist`),
      "__PROJECT_DIR__ __NODE_PATH__\n",
    );
  }
  const env = [
    `ALERT_WEBHOOK_URL=https://alerts.example.com/frontier`,
    `DEEPSEEK_API_KEY=sk-${"d".repeat(40)}`,
    `FEEDBACK_SECRET=${"f".repeat(40)}`,
    `SERVERCHAN_SENDKEY=SCT${"c".repeat(40)}`,
    `SUPABASE_SERVICE_ROLE_KEY=sb_secret_${"s".repeat(40)}`,
    `SUPABASE_URL=https://frontier-paper.supabase.co`,
    `WEB_BASE_URL=https://papers.example.com`,
  ].join("\n");
  writeFileSync(join(root, ".env"), `${env}\n`, { mode: 0o600 });

  const checks = await runDoctor(root, { home: parent, timeZone: "Asia/Shanghai" });

  expect(checks.find((check) => check.name === "launchd/com.frontierpapers.deliver.plist template")?.ok)
    .toBe(true);
  expect(checks.find((check) => check.name === "ingest:send preflight")?.ok).toBe(true);
  expect(checks.find((check) => check.name === "independent alert")?.ok).toBe(true);
  expect(checks.find((check) => check.name === "system time zone")?.ok).toBe(true);
  expect(checks.filter((check) => check.required).every((check) => check.ok)).toBe(true);
});
