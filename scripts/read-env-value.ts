import { readFileSync } from "node:fs";
import { parseEnvText } from "../lib/env-migration.ts";
import { ConfigError } from "../lib/runtime-config.ts";

const ALLOWED_KEYS = new Set([
  "AUTH_OWNER_EMAIL",
  "DEEPSEEK_API_KEY",
  "FEEDBACK_SECRET",
  "RATE_LIMIT_SECRET",
  "RATE_LIMIT_SECRET_VERSION",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "WEB_BASE_URL",
]);

const [, , path, key] = process.argv;
if (!path || !key || !ALLOWED_KEYS.has(key)) {
  throw new ConfigError([{ code: "INVALID", key: "environment key" }]);
}
process.stdout.write(parseEnvText(readFileSync(path, "utf8"))[key] ?? "");
