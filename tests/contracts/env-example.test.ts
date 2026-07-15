import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseEnvText } from "../../lib/env-migration.ts";
import { loadRootConfig } from "../../lib/runtime-config.ts";
import { loadWebRuntimeConfig } from "../../web/lib/runtime-config.ts";

describe("copyable environment examples", () => {
  test("root example passes ingest:send after only required values are replaced", () => {
    const env = parseEnvText(readFileSync(".env.example", "utf8"));
    Object.assign(env, {
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
      FEEDBACK_SECRET: "f".repeat(40),
      WEB_BASE_URL: "https://papers.example.com",
    });
    expect(() => loadRootConfig("ingest:send", env)).not.toThrow();
  });

  test("Web example passes private production after only required values are replaced", () => {
    const env = parseEnvText(readFileSync("web/.env.example", "utf8"));
    Object.assign(env, {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
      FEEDBACK_SECRET: "f".repeat(40),
      RATE_LIMIT_SECRET: "r".repeat(40),
      RATE_LIMIT_SECRET_VERSION: "1",
      WEB_BASE_URL: "https://papers.example.com",
    });
    expect(() => loadWebRuntimeConfig("production", env)).not.toThrow();
  });
});
