import { existsSync, lstatSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadRootConfig } from "../lib/runtime-config.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";
import { writeSecureFileExclusive } from "../lib/secure-file.ts";
import type { RuntimeEnvironment } from "../lib/runtime-env.ts";

const CLOUD_ENV_KEYS = Object.freeze([
  "ALERT_WEBHOOK_TOKEN",
  "ALERT_WEBHOOK_URL",
  "DEEPSEEK_API_KEY",
  "EMAIL_FROM",
  "EMAIL_TO",
  "FEEDBACK_SECRET",
  "GITHUB_TOKEN",
  "OPENALEX_API_KEY",
  "SERVERCHAN_SENDKEY",
  "SMTP_HOST",
  "SMTP_PASS",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "WEB_BASE_URL",
] as const);

function requireDirectory(path: string, key: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConfigError([{ code: "INVALID", key }]);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ConfigError([{ code: "INVALID", key: `${key} owner` }]);
  }
}

function ensureMissing(path: string, key: string): void {
  if (existsSync(path)) throw new ConfigError([{ code: "CONFLICT", key }]);
}

export function materializeCloudRuntime(
  root = resolve("."),
  environment: RuntimeEnvironment = process.env,
): Readonly<{ envPath: string; profilePath: string }> {
  const destinationRoot = resolve(root);
  requireDirectory(destinationRoot, "cloud repository");
  requireDirectory(resolve(destinationRoot, "config"), "cloud config");
  const config = loadRootConfig("ingest:send", environment);
  if (!config.alert) throw new ConfigError([{ code: "MISSING", key: "ALERT_WEBHOOK_URL" }]);
  const profile = environment.PROFILE_MD;
  if (
    typeof profile !== "string" ||
    !profile.trim() ||
    profile.includes("\0") ||
    Buffer.byteLength(profile, "utf8") > 128 * 1024
  ) {
    throw new ConfigError([{ code: "INVALID", key: "PROFILE_MD" }]);
  }

  const envPath = resolve(destinationRoot, ".env");
  const profilePath = resolve(destinationRoot, "config/profile.md");
  ensureMissing(envPath, ".env");
  ensureMissing(profilePath, "config/profile.md");
  const renderedEnvironment = CLOUD_ENV_KEYS.flatMap((key) => {
    const value = environment[key];
    return typeof value === "string" && value.length ? [`${key}=${JSON.stringify(value)}`] : [];
  }).join("\n") + "\n";

  let profileWritten = false;
  try {
    writeSecureFileExclusive(profilePath, profile);
    profileWritten = true;
    writeSecureFileExclusive(envPath, renderedEnvironment);
  } catch (error) {
    if (profileWritten) rmSync(profilePath, { force: true });
    throw error;
  }
  return Object.freeze({ envPath, profilePath });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = materializeCloudRuntime();
    console.log(`cloud runtime materialized: ${report.envPath}, ${report.profilePath}`);
  } catch (error) {
    console.error(`cloud runtime materialization failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
