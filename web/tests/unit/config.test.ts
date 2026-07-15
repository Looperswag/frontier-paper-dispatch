import { describe, expect, test } from "vitest";
import {
  WebConfigError,
  loadWebRuntimeConfig,
  normalizeAuthEmail,
  resolveAccessMode,
} from "@/lib/runtime-config";

const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const publishableKey = `sb_publishable_${"p".repeat(40)}`;
const deepseekKey = `sk-${"d".repeat(40)}`;
const rateLimitSecret = "r".repeat(40);
const legacyBase = {
  DEEPSEEK_API_KEY: deepseekKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
};
const base = {
  ...legacyBase,
  AUTH_OWNER_EMAIL: "owner@example.com",
  SUPABASE_PUBLISHABLE_KEY: publishableKey,
  FEEDBACK_SECRET: "f".repeat(40),
  RATE_LIMIT_SECRET: rateLimitSecret,
  RATE_LIMIT_SECRET_VERSION: "1",
  WEB_BASE_URL: "https://papers.example.com",
};

describe("web runtime configuration", () => {
  test("fails closed when production lacks Supabase Auth owner settings", () => {
    let error: unknown;
    try {
      loadWebRuntimeConfig("production", legacyBase);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WebConfigError);
    expect((error as WebConfigError).issues).toEqual(
      expect.arrayContaining([
        { code: "MISSING", key: "AUTH_OWNER_EMAIL" },
        { code: "MISSING", key: "SUPABASE_PUBLISHABLE_KEY" },
      ]),
    );
  });

  test("rejects an unknown runtime target", () => {
    const error = (() => {
      try {
        loadWebRuntimeConfig("unknown" as "data", base);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(WebConfigError);
    expect(String(error)).toContain("target");
    expect(String(error)).not.toContain("unknown");
  });

  test("uses owner Auth for every production and non-loopback deployment", () => {
    expect(resolveAccessMode({ NODE_ENV: "production" }, "papers.example.com")).toEqual({
      kind: "private",
    });
    expect(resolveAccessMode({ NODE_ENV: "production" }, "localhost")).toEqual({
      kind: "private",
    });
    expect(resolveAccessMode({ NODE_ENV: "development" }, "dev.example.com")).toEqual({
      kind: "private",
    });
  });

  test("allows unauthenticated development only on an explicit loopback host", () => {
    expect(resolveAccessMode({ NODE_ENV: "development" }, "localhost")).toEqual({ kind: "local" });
    expect(resolveAccessMode({ NODE_ENV: "development" }, "127.0.0.1")).toEqual({ kind: "local" });
    expect(resolveAccessMode({ NODE_ENV: "development" }, "dev.example.com")).toEqual({
      kind: "private",
    });
  });

  test("production access has no password-bearing property", () => {
    expect(resolveAccessMode({ ...base, NODE_ENV: "production" }, "papers.example.com")).toEqual({
      kind: "private",
    });
    expect(
      resolveAccessMode({ ...base, NODE_ENV: "production" }, "papers.example.com"),
    ).not.toHaveProperty("password");
  });

  test.each(["APP_PASSWORD", "NEXT_PUBLIC_DEMO_MODE"])(
    "rejects obsolete %s in every access mode",
    (key) => {
      for (const env of [
        { [key]: "legacy-value", NODE_ENV: "development" },
        { ...base, [key]: "legacy-value", NODE_ENV: "production" },
      ]) {
        expect(() => resolveAccessMode(env, "localhost")).toThrow(`OBSOLETE:${key}`);
      }
    },
  );

  test("rejects obsolete access keys without echoing their values", () => {
    const sentinel = "private-obsolete-access-value";
    let error: unknown;
    try {
      loadWebRuntimeConfig("production", { ...base, APP_PASSWORD: sentinel });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebConfigError);
    expect((error as WebConfigError).issues).toContainEqual({
      code: "OBSOLETE",
      key: "APP_PASSWORD",
    });
    expect(String(error) + JSON.stringify(error)).not.toContain(sentinel);
  });

  test("reports every required private production capability", () => {
    expect(() =>
      loadWebRuntimeConfig("production", { ...base, DEEPSEEK_API_KEY: undefined }),
    ).toThrow("DEEPSEEK_API_KEY");

    let error: unknown;
    try {
      loadWebRuntimeConfig("production", {
        AUTH_OWNER_EMAIL: base.AUTH_OWNER_EMAIL,
        NODE_ENV: "production",
        SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_URL: base.SUPABASE_URL,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebConfigError);
    expect((error as WebConfigError).issues).toEqual(
      expect.arrayContaining([{ code: "MISSING", key: "DEEPSEEK_API_KEY" }]),
    );

    expect(() =>
      loadWebRuntimeConfig("production", { ...base, FEEDBACK_SECRET: undefined }),
    ).toThrow("FEEDBACK_SECRET");
    expect(() =>
      loadWebRuntimeConfig("production", { ...base, WEB_BASE_URL: undefined }),
    ).toThrow("WEB_BASE_URL");
    expect(() =>
      loadWebRuntimeConfig("production", { ...base, RATE_LIMIT_SECRET: undefined }),
    ).toThrow("RATE_LIMIT_SECRET");
    expect(() =>
      loadWebRuntimeConfig("production", { ...base, RATE_LIMIT_SECRET_VERSION: undefined }),
    ).toThrow("RATE_LIMIT_SECRET_VERSION");
    const withoutFeedback = { ...base } as Record<string, string | undefined>;
    delete withoutFeedback.FEEDBACK_SECRET;
    delete withoutFeedback.WEB_BASE_URL;
    expect(() => loadWebRuntimeConfig("production", withoutFeedback)).toThrow(
      /FEEDBACK_SECRET|WEB_BASE_URL/,
    );
  });

  test("validates server capabilities independently for lazy modules", () => {
    expect(loadWebRuntimeConfig("data", base).supabase).toBeTruthy();
    expect(loadWebRuntimeConfig("auth", base).auth).toEqual({
      ownerEmail: "owner@example.com",
      publishableKey,
      url: base.SUPABASE_URL,
    });
    expect(loadWebRuntimeConfig("llm", base).deepseek).toBeTruthy();
    expect(loadWebRuntimeConfig("quota", base).quota).toEqual({
      secret: rateLimitSecret,
      secretVersion: 1,
      serviceRoleKey,
      url: base.SUPABASE_URL,
    });
    expect(() => loadWebRuntimeConfig("data", { SUPABASE_URL: base.SUPABASE_URL })).toThrow(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
  });

  test("normalizes the single owner email without exposing it publicly", () => {
    expect(normalizeAuthEmail("  Owner.User+Papers@Example.COM ")).toBe(
      "owner.user+papers@example.com",
    );
    expect(
      loadWebRuntimeConfig("auth", {
        AUTH_OWNER_EMAIL: "  Owner.User+Papers@Example.COM ",
        SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_URL: base.SUPABASE_URL,
      }).auth,
    ).toEqual({
      ownerEmail: "owner.user+papers@example.com",
      publishableKey,
      url: base.SUPABASE_URL,
    });
  });

  test.each([
    "two@example.com,other@example.com",
    "missing-domain@example",
    "@example.com",
    ".owner@example.com",
    "owner.@example.com",
    "owner..name@example.com",
    "owner@-example.com",
  ])("rejects invalid owner email %s without echoing it", (ownerEmail) => {
    let error: unknown;
    try {
      loadWebRuntimeConfig("auth", {
        AUTH_OWNER_EMAIL: ownerEmail,
        SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_URL: base.SUPABASE_URL,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebConfigError);
    expect(String(error) + JSON.stringify(error)).not.toContain(ownerEmail);
  });

  test("accepts a legacy anon JWT for Auth but rejects service-role credentials", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const anonJWT = `${header}.${encode({ role: "anon" })}.signature`;
    const serviceJWT = `${header}.${encode({ role: "service_role" })}.signature`;

    expect(
      loadWebRuntimeConfig("auth", {
        AUTH_OWNER_EMAIL: base.AUTH_OWNER_EMAIL,
        SUPABASE_PUBLISHABLE_KEY: anonJWT,
        SUPABASE_URL: base.SUPABASE_URL,
      }).auth?.publishableKey,
    ).toBe(anonJWT);
    for (const rejected of [serviceJWT, serviceRoleKey]) {
      expect(() =>
        loadWebRuntimeConfig("auth", {
          AUTH_OWNER_EMAIL: base.AUTH_OWNER_EMAIL,
          SUPABASE_PUBLISHABLE_KEY: rejected,
          SUPABASE_URL: base.SUPABASE_URL,
        }),
      ).toThrow("SUPABASE_PUBLISHABLE_KEY");
    }
  });

  test.each([
    ["publishable key", { ...base, SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${"p".repeat(32)}` }],
    ["Supabase placeholder", { ...base, SUPABASE_URL: "https://xxxx.supabase.co" }],
    ["Web placeholder", { ...base, FEEDBACK_SECRET: "f".repeat(40), WEB_BASE_URL: "https://your-app.vercel.app" }],
  ])("rejects %s", (_name, env) => {
    expect(() => loadWebRuntimeConfig("production", env)).toThrow(WebConfigError);
  });

  test("rejects anon JWT keys while accepting service-role JWT keys", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const anonJWT = `${header}.${encode({ role: "anon" })}.signature`;
    const serviceJWT = `${header}.${encode({ role: "service_role" })}.signature`;
    for (const rejected of [anonJWT, "opaque-but-long-enough-service-token", "a.b.not-json"]) {
      expect(() =>
        loadWebRuntimeConfig("data", { ...base, SUPABASE_SERVICE_ROLE_KEY: rejected }),
      ).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    }
    expect(
      loadWebRuntimeConfig("data", { ...base, SUPABASE_SERVICE_ROLE_KEY: serviceJWT }).supabase,
    ).toBeTruthy();
  });

  test("validates feedback configuration as a pair", () => {
    let pairError: unknown;
    try {
      loadWebRuntimeConfig("feedback", { WEB_BASE_URL: "https://papers.example.com" });
    } catch (caught) {
      pairError = caught;
    }
    expect(pairError).toBeInstanceOf(WebConfigError);
    expect(
      (pairError as WebConfigError).issues.filter((issue) => issue.key === "FEEDBACK_SECRET"),
    ).toEqual([{ code: "MISSING", key: "FEEDBACK_SECRET" }]);
    expect(() =>
      loadWebRuntimeConfig("feedback", {
        FEEDBACK_SECRET: "short",
        WEB_BASE_URL: "https://papers.example.com",
      }),
    ).toThrow("FEEDBACK_SECRET");
    expect(
      loadWebRuntimeConfig("feedback", {
        FEEDBACK_SECRET: "f".repeat(40),
        WEB_BASE_URL: "https://papers.example.com",
      }).feedback,
    ).toBeTruthy();
  });

  test.each([
    ["short secret", { ...base, RATE_LIMIT_SECRET: "short" }],
    ["placeholder secret", { ...base, RATE_LIMIT_SECRET: "replace-with-random-secret" }],
    ["multiline secret", { ...base, RATE_LIMIT_SECRET: `${rateLimitSecret}\nprivate` }],
    ["zero version", { ...base, RATE_LIMIT_SECRET_VERSION: "0" }],
    ["leading-zero version", { ...base, RATE_LIMIT_SECRET_VERSION: "01" }],
    ["fractional version", { ...base, RATE_LIMIT_SECRET_VERSION: "1.5" }],
    ["oversized version", { ...base, RATE_LIMIT_SECRET_VERSION: "1000000" }],
  ])("rejects invalid quota configuration: %s", (_name, env) => {
    expect(() => loadWebRuntimeConfig("quota", env)).toThrow(WebConfigError);
  });

  test("rejects the published example feedback secret", () => {
    expect(() =>
      loadWebRuntimeConfig("production", {
        ...base,
        FEEDBACK_SECRET: "replace-with-at-least-32-random-bytes",
        WEB_BASE_URL: "https://papers.example.com",
      }),
    ).toThrow(WebConfigError);
  });

  test("does not mistake a legitimate your-company hostname for a placeholder", () => {
    expect(
      loadWebRuntimeConfig("feedback", {
        FEEDBACK_SECRET: "f".repeat(40),
        WEB_BASE_URL: "https://your-company.com",
      }).feedback?.webBaseURL,
    ).toBe("https://your-company.com");
  });

  test.each([
    ["multiline DeepSeek key", { ...base, DEEPSEEK_API_KEY: `sk-${"a".repeat(20)}\ninside` }],
  ])("rejects %s that cannot be transported reliably", (_name, env) => {
    expect(() => loadWebRuntimeConfig("production", env)).toThrow(WebConfigError);
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
    "NEXT_PUBLIC_RATE_LIMIT_SECRET",
  ])("rejects forbidden public secret %s", (key) => {
    expect(() => loadWebRuntimeConfig("data", { ...base, [key]: "sentinel" })).toThrow(key);
  });

  test("never renders invalid secret values in an error", () => {
    const sentinel = "do-not-print-this-private-value";
    const error = (() => {
      try {
        loadWebRuntimeConfig("data", {
          SUPABASE_SERVICE_ROLE_KEY: sentinel,
          SUPABASE_URL: `https://${sentinel}@example.com`,
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(WebConfigError);
    expect(JSON.stringify(error) + String(error)).not.toContain(sentinel);
  });
});
