import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  loadWebRuntimeConfig,
  resolveAccessMode,
  WebConfigError,
} from "../../web/lib/runtime-config.ts";

const production = {
  AUTH_OWNER_EMAIL: "owner@example.com",
  DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
  FEEDBACK_SECRET: "f".repeat(40),
  NODE_ENV: "production",
  RATE_LIMIT_SECRET: "r".repeat(40),
  RATE_LIMIT_SECRET_VERSION: "1",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
  WEB_BASE_URL: "https://papers.example.com",
};

describe("final Supabase Auth cutover", () => {
  test("production is private without any Basic or demo configuration", () => {
    const config = loadWebRuntimeConfig("production", production);

    expect(config.access).toEqual({ kind: "private" });
    expect(config.access).not.toHaveProperty("password");
    expect(resolveAccessMode(production, "localhost")).toEqual({ kind: "private" });
    expect(resolveAccessMode({ NODE_ENV: "development" }, "localhost")).toEqual({
      kind: "local",
    });
    expect(resolveAccessMode({ NODE_ENV: "development" }, "dev.example.com")).toEqual({
      kind: "private",
    });
  });

  test.each(["APP_PASSWORD", "NEXT_PUBLIC_DEMO_MODE"])(
    "rejects a residual %s by key only",
    (key) => {
      const sentinel = `private-${key.toLowerCase()}-sentinel`;
      let error: unknown;
      try {
        loadWebRuntimeConfig("production", { ...production, [key]: sentinel });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(WebConfigError);
      expect((error as WebConfigError).issues).toContainEqual({ code: "OBSOLETE", key });
      expect(String(error) + JSON.stringify(error)).not.toContain(sentinel);
    },
  );

  test("removes obsolete access switches from active code, CI, examples, and current docs", () => {
    const paths = [
      ".github/workflows/ci.yml",
      "README.md",
      "SPEC.md",
      "web/.env.example",
      "web/README.md",
      "web/playwright.config.ts",
      "web/app/(private)/layout.tsx",
      "web/components/AnnotatedReader.tsx",
      "web/components/ChatPanel.tsx",
      "web/components/FeedbackButtons.tsx",
    ];
    for (const path of paths) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(
        /APP_PASSWORD|NEXT_PUBLIC_DEMO_MODE|Basic Auth|只读 demo/i,
      );
    }
    expect(existsSync("web/lib/config.public.ts")).toBe(false);

    const reader = readFileSync("scripts/read-env-value.ts", "utf8");
    expect(reader).not.toMatch(/APP_PASSWORD|NEXT_PUBLIC_DEMO_MODE/);
  });

  test("local Supabase disables signup and anonymous identities", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    expect(config).toMatch(/\[auth\][\s\S]*?enable_signup\s*=\s*false/);
    expect(config).toMatch(/\[auth\.email\][\s\S]*?enable_signup\s*=\s*false/);
    expect(config).toMatch(/enable_anonymous_sign_ins\s*=\s*false/);
    expect(config).toMatch(/minimum_password_length\s*=\s*(?:1[2-9]|[2-9]\d)/);
  });
});
