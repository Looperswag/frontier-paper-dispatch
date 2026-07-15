import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseEnvText } from "../../lib/env-migration.ts";
import { materializeCloudRuntime } from "../../scripts/materialize-cloud-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "frontier-cloud-runtime-"));
  temporaryDirectories.push(value);
  mkdirSync(join(value, "config"));
  return value;
}

function environment() {
  return {
    ALERT_WEBHOOK_URL: "https://alerts.example.test/frontier",
    DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
    FEEDBACK_SECRET: "f".repeat(40),
    GITHUB_TOKEN: `github_pat_${"g".repeat(40)}`,
    PROFILE_MD: "# Cloud profile\n多行画像。\n",
    SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
    SUPABASE_URL: "https://frontier-paper.supabase.co",
    UNRELATED_SECRET: "must-not-be-materialized",
    WEB_BASE_URL: "https://papers.example.test",
  };
}

test("materializes only validated allowlisted runtime values and the private profile", () => {
  const destinationRoot = root();
  const report = materializeCloudRuntime(destinationRoot, environment());
  const envPath = join(destinationRoot, ".env");
  const profilePath = join(destinationRoot, "config/profile.md");
  const parsed = parseEnvText(readFileSync(envPath, "utf8"));

  expect(report).toEqual({ envPath, profilePath });
  expect(parsed).toMatchObject({
    ALERT_WEBHOOK_URL: "https://alerts.example.test/frontier",
    SUPABASE_URL: "https://frontier-paper.supabase.co",
  });
  expect(parsed.UNRELATED_SECRET).toBeUndefined();
  expect(parsed.PROFILE_MD).toBeUndefined();
  expect(readFileSync(envPath, "utf8")).not.toContain("must-not-be-materialized");
  expect(readFileSync(profilePath, "utf8")).toBe(environment().PROFILE_MD);
  expect(lstatSync(envPath).mode & 0o777).toBe(0o600);
  expect(lstatSync(profilePath).mode & 0o777).toBe(0o600);
});

test("fails closed before writing when profile, alerting, or provider config is incomplete", () => {
  for (const missing of ["PROFILE_MD", "ALERT_WEBHOOK_URL", "SERVERCHAN_SENDKEY"] as const) {
    const destinationRoot = root();
    const env = { ...environment() };
    delete env[missing];

    expect(() => materializeCloudRuntime(destinationRoot, env)).toThrow();
    expect(existsSync(join(destinationRoot, ".env"))).toBe(false);
    expect(existsSync(join(destinationRoot, "config/profile.md"))).toBe(false);
  }
});

test("never overwrites either runtime file", () => {
  const destinationRoot = root();
  writeFileSync(join(destinationRoot, ".env"), "keep", { mode: 0o600 });

  expect(() => materializeCloudRuntime(destinationRoot, environment())).toThrow();
  expect(readFileSync(join(destinationRoot, ".env"), "utf8")).toBe("keep");
  expect(existsSync(join(destinationRoot, "config/profile.md"))).toBe(false);
});

test("cleans a staged profile if a broken-link env target wins the write", () => {
  const destinationRoot = root();
  symlinkSync(join(destinationRoot, "missing-env-target"), join(destinationRoot, ".env"));

  expect(() => materializeCloudRuntime(destinationRoot, environment())).toThrow();
  expect(existsSync(join(destinationRoot, "config/profile.md"))).toBe(false);
  expect(lstatSync(join(destinationRoot, ".env")).isSymbolicLink()).toBe(true);
});

test("rejects a non-directory config boundary", () => {
  const destinationRoot = root();
  rmSync(join(destinationRoot, "config"), { recursive: true });
  writeFileSync(join(destinationRoot, "config"), "not-a-directory");

  expect(() => materializeCloudRuntime(destinationRoot, environment())).toThrow();
  expect(existsSync(join(destinationRoot, ".env"))).toBe(false);
});
