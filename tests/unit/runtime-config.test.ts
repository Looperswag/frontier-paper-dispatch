import { describe, expect, test } from "vitest";
import {
  ConfigError,
  loadDeepSeekConfig,
  loadFeedbackConfig,
  loadOptionalFeedbackConfig,
  loadOptionalSMTPConfig,
  loadRootConfig,
  loadServerChanConfig,
  loadSupabaseConfig,
  type ConfigTarget,
} from "../../lib/runtime-config.ts";

const deepseekKey = `sk-${"d".repeat(40)}`;
const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const serverChanKey = `SCT${"c".repeat(40)}`;
const feedbackSecret = "f".repeat(40);

const valid = {
  DEEPSEEK_API_KEY: deepseekKey,
  FEEDBACK_SECRET: feedbackSecret,
  SERVERCHAN_SENDKEY: serverChanKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
  WEB_BASE_URL: "https://papers.example.com",
};

describe("loadRootConfig", () => {
  test("allows dry collection with no private configuration", () => {
    expect(loadRootConfig("dry", {})).toMatchObject({ target: "dry", deprecations: [] });
  });

  test("rejects an unknown runtime target instead of treating it as no requirements", () => {
    const error = (() => {
      try {
        loadRootConfig("not-a-target" as ConfigTarget, valid);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("target");
    expect(String(error)).not.toContain("not-a-target");
  });

  test.each<[ConfigTarget, string]>([
    ["ingest", "SUPABASE_URL"],
    ["ingest", "SUPABASE_SERVICE_ROLE_KEY"],
    ["ingest", "DEEPSEEK_API_KEY"],
    ["ingest", "FEEDBACK_SECRET"],
    ["ingest", "WEB_BASE_URL"],
    ["ingest:send", "SERVERCHAN_SENDKEY"],
    ["ingest:send", "FEEDBACK_SECRET"],
    ["ingest:send", "WEB_BASE_URL"],
    ["push:last", "SERVERCHAN_SENDKEY"],
    ["push:last", "FEEDBACK_SECRET"],
    ["push:last", "WEB_BASE_URL"],
    ["refine", "DEEPSEEK_API_KEY"],
  ])("fails %s before work starts when %s is missing", (target, missing) => {
    const env = { ...valid, [missing]: undefined };
    expect(() => loadRootConfig(target, env)).toThrow(missing);
  });

  test("returns a frozen typed capability object", () => {
    const config = loadRootConfig("ingest:send", valid);
    expect(config).toMatchObject({
      deepseek: { apiKey: deepseekKey, baseURL: "https://api.deepseek.com" },
      serverChan: { sendKey: serverChanKey },
      supabase: { serviceRoleKey, url: "https://frontier-paper.supabase.co" },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.supabase)).toBe(true);
    expect(Object.isFrozen(config.deepseek)).toBe(true);
    expect(Object.isFrozen(config.serverChan)).toBe(true);
    expect(Object.isFrozen(config.deprecations)).toBe(true);
  });

  test("accepts a complete SMTP capability while keeping it server-only", () => {
    const config = loadRootConfig("dry", {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "mailer@example.com",
      SMTP_PASS: "private-pass",
      EMAIL_FROM: "mailer@example.com",
      EMAIL_TO: "hgjly1206@163.com",
    });
    expect(config.smtp).toMatchObject({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      from: "mailer@example.com",
      to: "hgjly1206@163.com",
    });
    expect(loadOptionalSMTPConfig({})).toBeUndefined();
  });

  test("accepts a server-only optional OpenAlex API key", () => {
    expect(loadRootConfig("dry", { OPENALEX_API_KEY: "openalex-private-key" }))
      .toMatchObject({ openAlexApiKey: "openalex-private-key" });
    expect(() => loadRootConfig("dry", { NEXT_PUBLIC_OPENALEX_API_KEY: "public-leak" }))
      .toThrow("FORBIDDEN_PUBLIC_SECRET:NEXT_PUBLIC_OPENALEX_API_KEY");
  });

  test("accepts an HTTPS independent alert webhook and rejects remote HTTP", () => {
    expect(loadRootConfig("dry", {
      ALERT_WEBHOOK_URL: "https://alerts.example.com/frontier",
      ALERT_WEBHOOK_TOKEN: "token",
    }).alert).toEqual({
      webhookURL: "https://alerts.example.com/frontier",
      token: "token",
    });
    expect(() => loadRootConfig("dry", { ALERT_WEBHOOK_URL: "http://alerts.example.com/hook" }))
      .toThrow("ALERT_WEBHOOK_URL");
  });

  test("rejects partial or unsafe SMTP configuration", () => {
    expect(() => loadRootConfig("dry", { SMTP_HOST: "smtp.example.com" })).toThrow("SMTP_PORT");
    expect(() => loadRootConfig("dry", {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "25",
      SMTP_SECURE: "false",
      SMTP_USER: "mailer@example.com",
      SMTP_PASS: "private-pass",
      EMAIL_FROM: "mailer@example.com",
      EMAIL_TO: "recipient\n@example.com",
    })).toThrow("EMAIL_TO");
  });

  test("accepts loopback HTTP Supabase for local tests but rejects remote HTTP", () => {
    expect(
      loadRootConfig("ingest", { ...valid, SUPABASE_URL: "http://127.0.0.1:54321" }),
    ).toBeTruthy();
    expect(() =>
      loadRootConfig("ingest", { ...valid, SUPABASE_URL: "http://papers.example.com" }),
    ).toThrow("SUPABASE_URL");
  });

  test("does not mistake a legitimate your-company hostname for a placeholder", () => {
    expect(
      loadRootConfig("dry", {
        FEEDBACK_SECRET: feedbackSecret,
        WEB_BASE_URL: "https://your-company.com",
      }).feedback?.webBaseURL,
    ).toBe("https://your-company.com");
  });

  test.each([
    ["placeholder DeepSeek key", { ...valid, DEEPSEEK_API_KEY: "sk-..." }],
    ["placeholder service key", { ...valid, SUPABASE_SERVICE_ROLE_KEY: "eyJ..." }],
    ["publishable key", { ...valid, SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${"p".repeat(32)}` }],
    ["short GitHub token", { ...valid, GITHUB_TOKEN: "ghp_short" }],
    ["placeholder GitHub token", { ...valid, GITHUB_TOKEN: "github_pat_replace-me" }],
    ["invalid ServerChan key", { ...valid, SERVERCHAN_SENDKEY: "wrong-key" }],
    ["credentialed URL", { ...valid, SUPABASE_URL: "https://user:pass@example.com" }],
    ["Supabase URL placeholder", { ...valid, SUPABASE_URL: "https://xxxx.supabase.co" }],
    ["Web URL placeholder", { ...valid, WEB_BASE_URL: "https://your-app.vercel.app" }],
  ])("rejects %s without echoing its value", (_name, env) => {
    const secretValues = Object.values(env);
    const error = (() => {
      try {
        loadRootConfig("ingest:send", env);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const rendered = JSON.stringify(error) + String(error);
    for (const value of secretValues) {
      expect(rendered).not.toContain(value);
    }
  });

  test("rejects an anon JWT but accepts legacy service-role and new secret keys", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const anonJWT = `${header}.${encode({ role: "anon" })}.signature`;
    const serviceJWT = `${header}.${encode({ role: "service_role" })}.signature`;

    expect(() =>
      loadRootConfig("ingest", { ...valid, SUPABASE_SERVICE_ROLE_KEY: anonJWT }),
    ).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(
      loadRootConfig("ingest", { ...valid, SUPABASE_SERVICE_ROLE_KEY: serviceJWT }).supabase,
    ).toBeTruthy();
    expect(
      loadRootConfig("ingest", {
        ...valid,
        SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"q".repeat(32)}`,
      }).supabase,
    ).toBeTruthy();
  });

  test("requires feedback URL and secret as a validated pair", () => {
    expect(() => loadRootConfig("dry", { WEB_BASE_URL: valid.WEB_BASE_URL })).toThrow(
      "FEEDBACK_SECRET",
    );
    expect(() => loadRootConfig("dry", { FEEDBACK_SECRET: feedbackSecret })).toThrow(
      "WEB_BASE_URL",
    );
    expect(() =>
      loadRootConfig("dry", {
        FEEDBACK_SECRET: "short",
        WEB_BASE_URL: valid.WEB_BASE_URL,
      }),
    ).toThrow("FEEDBACK_SECRET");
  });

  test("uses only the two explicit legacy aliases and reports deprecations", () => {
    const config = loadRootConfig("ingest:send", {
      FEEDBACK_SECRET: feedbackSecret,
      LLM_API_KEY: deepseekKey,
      LLM_BASE_URL: "https://api.deepseek.com/v1",
      LLM_PROVIDER: "deepseek",
      SERVERCHAN_KEY: serverChanKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_URL: valid.SUPABASE_URL,
      WEB_BASE_URL: valid.WEB_BASE_URL,
    });

    expect(config.deepseek?.apiKey).toBe(deepseekKey);
    expect(config.serverChan?.sendKey).toBe(serverChanKey);
    expect(config.deprecations).toEqual([
      "LLM_API_KEY->DEEPSEEK_API_KEY",
      "SERVERCHAN_KEY->SERVERCHAN_SENDKEY",
    ]);
  });

  test("does not reinterpret an old database URL or a non-DeepSeek LLM key", () => {
    expect(() =>
      loadRootConfig("ingest", {
        DB_URL: "postgresql:///private/old.db",
        LLM_API_KEY: deepseekKey,
        LLM_BASE_URL: "https://api.other-provider.example/v1",
        LLM_PROVIDER: "other",
      }),
    ).toThrow(/DEEPSEEK_API_KEY|SUPABASE_URL/);
  });

  test("fails a canonical/legacy conflict without disclosing either value", () => {
    const canonical = `SCT${"a".repeat(40)}`;
    const legacy = `SCT${"b".repeat(40)}`;
    const error = (() => {
      try {
        loadRootConfig("ingest:send", {
          ...valid,
          SERVERCHAN_KEY: legacy,
          SERVERCHAN_SENDKEY: canonical,
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toMatch(/SERVERCHAN_KEY.*SERVERCHAN_SENDKEY|SERVERCHAN_SENDKEY.*SERVERCHAN_KEY/);
    expect(String(error)).not.toMatch(new RegExp(`${canonical}|${legacy}`));
  });

  test("keeps warning about a retained legacy key after canonical migration", () => {
    const config = loadRootConfig("dry", {
      SERVERCHAN_KEY: serverChanKey,
      SERVERCHAN_SENDKEY: serverChanKey,
    });
    expect(config.deprecations).toEqual(["SERVERCHAN_KEY->SERVERCHAN_SENDKEY"]);
  });

  test.each([
    "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_DEEPSEEK_API_KEY",
    "NEXT_PUBLIC_FEEDBACK_SECRET",
    "NEXT_PUBLIC_APP_PASSWORD",
    "NEXT_PUBLIC_GITHUB_TOKEN",
    "NEXT_PUBLIC_SERVERCHAN_SENDKEY",
    "NEXT_PUBLIC_SERVERCHAN_KEY",
    "NEXT_PUBLIC_LLM_API_KEY",
    "NEXT_PUBLIC_SMTP_PASS",
    "NEXT_PUBLIC_EMAIL_TO",
    "NEXT_PUBLIC_ALERT_WEBHOOK_URL",
    "NEXT_PUBLIC_ALERT_WEBHOOK_TOKEN",
  ])("rejects forbidden public secret variable %s", (key) => {
    expect(() => loadRootConfig("dry", { [key]: "never-public" })).toThrow(key);
  });

  test.each([
    "VITE_ALERT_WEBHOOK_URL",
    "PUBLIC_ALERT_WEBHOOK_TOKEN",
    "NUXT_PUBLIC_ALERT_WEBHOOK_URL",
    "REACT_APP_ALERT_WEBHOOK_TOKEN",
  ])("rejects alert credentials under public framework prefix %s", (key) => {
    expect(() => loadRootConfig("dry", { [key]: "never-public" })).toThrow(key);
  });

  test("strictly rejects a malformed supplied capability even when dry does not need it", () => {
    expect(() => loadRootConfig("dry", { SERVERCHAN_SENDKEY: "wrong-key" })).toThrow(
      "SERVERCHAN_SENDKEY",
    );
  });

  test.each([
    ["DeepSeek key", { DEEPSEEK_API_KEY: `sk-${"a".repeat(20)}\ninside` }],
    ["service-role key", { SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"a".repeat(20)}\ninside`, SUPABASE_URL: valid.SUPABASE_URL }],
    ["GitHub token", { GITHUB_TOKEN: "github_pat_valid\u0000suffix" }],
    ["feedback secret", { FEEDBACK_SECRET: `${"f".repeat(32)}\u0000suffix`, WEB_BASE_URL: valid.WEB_BASE_URL }],
  ])("rejects control characters in supplied %s", (_name, env) => {
    expect(() => loadRootConfig("dry", env)).toThrow(ConfigError);
  });

  test("exposes typed capability loaders with fail-closed missing behavior", () => {
    expect(loadDeepSeekConfig(valid).apiKey).toBe(deepseekKey);
    expect(loadSupabaseConfig(valid).serviceRoleKey).toBe(serviceRoleKey);
    expect(loadServerChanConfig(valid).sendKey).toBe(serverChanKey);
    expect(loadFeedbackConfig(valid).secret).toBe(feedbackSecret);
    expect(loadOptionalFeedbackConfig({})).toBeUndefined();
    expect(() => loadDeepSeekConfig({})).toThrow("DEEPSEEK_API_KEY");
    expect(() => loadSupabaseConfig({})).toThrow("SUPABASE_URL");
    expect(() => loadServerChanConfig({})).toThrow("SERVERCHAN_SENDKEY");
    expect(() => loadFeedbackConfig({})).toThrow("FEEDBACK_SECRET");
  });
});
