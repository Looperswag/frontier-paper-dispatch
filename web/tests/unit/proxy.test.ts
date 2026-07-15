import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { config, proxy } from "@/proxy";

const originalEnvironment = { ...process.env };
const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const publishableKey = `sb_publishable_${"p".repeat(40)}`;
const deepseekKey = `sk-${"d".repeat(40)}`;
const password = "strong-private-password";
const ownerId = "00000000-0000-4000-8000-000000000701";

function validClaims() {
  return {
    data: {
      claims: { role: "authenticated", sub: ownerId },
      header: { alg: "RS256", typ: "JWT" },
      signature: new Uint8Array([1]),
    },
    error: null,
  };
}

function configure(values: Record<string, string | undefined>): void {
  for (const key of [
    "AUTH_OWNER_EMAIL",
    "DEEPSEEK_API_KEY",
    "FEEDBACK_SECRET",
    "NODE_ENV",
    "RATE_LIMIT_SECRET",
    "RATE_LIMIT_SECRET_VERSION",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
    "WEB_BASE_URL",
  ]) {
    vi.stubEnv(key, values[key] ?? "");
  }
}

function configurePrivate(): void {
  configure({
    AUTH_OWNER_EMAIL: "owner@example.com",
    DEEPSEEK_API_KEY: deepseekKey,
    FEEDBACK_SECRET: "f".repeat(40),
    NODE_ENV: "production",
    RATE_LIMIT_SECRET: "r".repeat(40),
    RATE_LIMIT_SECRET_VERSION: "1",
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_URL: "https://frontier-paper.supabase.co",
    WEB_BASE_URL: "https://papers.example.com",
  });
}

function authorizedRequest(path = "/", cookie?: string): NextRequest {
  return new NextRequest(`https://papers.example.com${path}`, {
    headers: {
      Authorization: `Basic ${btoa(`owner:${password}`)}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

beforeEach(() => {
  mocks.getClaims.mockReset().mockResolvedValue({ data: { claims: null }, error: null });
  mocks.createServerClient.mockReset().mockReturnValue({
    auth: { getClaims: mocks.getClaims },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(process.env, originalEnvironment);
});

describe("Next 16 access and Auth refresh proxy", () => {
  test("returns a generic 503 when production Auth protection is missing or obsolete", async () => {
    configure({ NODE_ENV: "production" });
    const missing = await proxy(new NextRequest("https://papers.example.com/"));
    expect(missing.status).toBe(503);
    expect(missing.headers.get("x-middleware-next")).toBeNull();
    await expect(missing.text()).resolves.not.toMatch(/APP_PASSWORD|SUPABASE|DEEPSEEK/);

    configure({
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: deepseekKey,
      NODE_ENV: "production",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    });
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "1");
    expect((await proxy(new NextRequest("https://papers.example.com/"))).status).toBe(503);
  });

  test("rejects a residual production demo switch", async () => {
    configure({
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: deepseekKey,
      NODE_ENV: "production",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    });
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "1");

    expect((await proxy(new NextRequest("https://papers.example.com/"))).status).toBe(503);
  });

  test("allows loopback development Proxy pass-through for final route guards", async () => {
    configure({ NODE_ENV: "development" });

    const read = await proxy(new NextRequest("http://localhost:3000/"));
    const write = await proxy(
      new NextRequest("http://localhost:3000/api/chat", { method: "POST" }),
    );
    expect(read.headers.get("x-middleware-next")).toBe("1");
    expect(write.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  test("ignores legacy Basic credentials and follows only the verified session decision", async () => {
    configurePrivate();
    mocks.getClaims
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce(validClaims());
    const missing = await proxy(new NextRequest("https://papers.example.com/"));
    const wrong = await proxy(
      new NextRequest("https://papers.example.com/api/feedback", {
        headers: { Authorization: `Basic ${btoa("owner:wrong")}` },
      }),
    );
    const correct = await proxy(authorizedRequest("/api/feedback", "sb-session=valid"));

    expect(missing.status).toBe(307);
    expect(wrong.status).toBe(401);
    expect(correct.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.createServerClient).toHaveBeenCalledTimes(3);
    expect(mocks.getClaims).toHaveBeenCalledTimes(3);
  });

  test("exposes only the exact login page and Auth POST methods after the Basic cutover", async () => {
    configurePrivate();

    for (const [path, method] of [
      ["/login", "GET"],
      ["/login", "HEAD"],
      ["/api/auth/login", "POST"],
      ["/api/auth/logout", "POST"],
    ] as const) {
      const response = await proxy(
        new NextRequest(`https://papers.example.com${path}`, { method }),
      );
      expect(response.headers.get("x-middleware-next"), `${method} ${path}`).toBe("1");
    }

    for (const [path, method, status] of [
      ["/", "GET", 307],
      ["/api/chat", "POST", 401],
      ["/api/auth/login", "GET", 401],
      ["/api/auth/logout", "GET", 401],
      ["/login.evil", "GET", 307],
      ["/login/extra", "GET", 307],
      ["/api/auth/login/extra", "POST", 401],
    ] as const) {
      const response = await proxy(
        new NextRequest(`https://papers.example.com${path}`, { method }),
      );
      expect(response.status, `${method} ${path}`).toBe(status);
    }

    expect(mocks.createServerClient).toHaveBeenCalledTimes(7);
  });

  test("synchronizes refreshed cookies and all required anti-cache headers", async () => {
    configurePrivate();
    const request = authorizedRequest("/paper/one", "sb-session=old-cookie");
    let cookiesSeen: unknown;
    mocks.getClaims.mockImplementationOnce(async () => {
      const options = mocks.createServerClient.mock.calls[0][2] as {
        cookies: {
          getAll: () => unknown;
          setAll: (
            values: Array<{ name: string; options: Record<string, unknown>; value: string }>,
            headers: Record<string, string>,
          ) => void;
        };
      };
      cookiesSeen = options.cookies.getAll();
      options.cookies.setAll(
        [{ name: "sb-session", value: "new-cookie", options: { httpOnly: true, path: "/" } }],
        {
          "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
          Expires: "0",
          Pragma: "no-cache",
        },
      );
      return validClaims();
    });

    const response = await proxy(request);

    expect(cookiesSeen).toEqual(expect.arrayContaining([{ name: "sb-session", value: "old-cookie" }]));
    expect(mocks.createServerClient).toHaveBeenCalledWith(
      "https://frontier-paper.supabase.co",
      publishableKey,
      expect.any(Object),
    );
    expect(mocks.createServerClient).not.toHaveBeenCalledWith(
      expect.anything(),
      serviceRoleKey,
      expect.anything(),
    );
    expect(request.cookies.get("sb-session")?.value).toBe("new-cookie");
    expect(response.cookies.get("sb-session")?.value).toBe("new-cookie");
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
  });

  test("propagates revoked-session cookie removal", async () => {
    configurePrivate();
    mocks.getClaims.mockImplementationOnce(async () => {
      const options = mocks.createServerClient.mock.calls[0][2] as {
        cookies: {
          setAll: (
            values: Array<{ name: string; options: Record<string, unknown>; value: string }>,
            headers: Record<string, string>,
          ) => void;
        };
      };
      options.cookies.setAll(
        [{ name: "sb-session", value: "", options: { maxAge: 0, path: "/" } }],
        { "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" },
      );
      return { data: { claims: null }, error: { code: "session_not_found" } };
    });

    const response = await proxy(authorizedRequest("/", "sb-session=revoked"));

    expect(response.headers.get("set-cookie")).toMatch(/sb-session=;.*Max-Age=0/i);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("creates a fresh SSR client for separate requests", async () => {
    configurePrivate();
    const cookieSnapshots: unknown[] = [];
    mocks.getClaims.mockImplementation(async () => {
      const call = mocks.createServerClient.mock.calls[cookieSnapshots.length];
      cookieSnapshots.push((call[2] as { cookies: { getAll: () => unknown } }).cookies.getAll());
      return { data: { claims: null }, error: null };
    });

    await proxy(authorizedRequest("/paper/a", "sb-session=request-a"));
    await proxy(authorizedRequest("/paper/b", "sb-session=request-b"));

    expect(mocks.createServerClient).toHaveBeenCalledTimes(2);
    expect(cookieSnapshots).toEqual([
      expect.arrayContaining([{ name: "sb-session", value: "request-a" }]),
      expect.arrayContaining([{ name: "sb-session", value: "request-b" }]),
    ]);
  });

  test("fails closed generically when session refresh throws", async () => {
    configurePrivate();
    mocks.getClaims.mockRejectedValueOnce(new Error("private Auth outage detail"));

    const response = await proxy(authorizedRequest());

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.not.toContain("private Auth outage detail");
  });

  test("permits passwordless development only on loopback", async () => {
    configure({ NODE_ENV: "development" });
    expect(
      (await proxy(new NextRequest("http://localhost:3000/"))).headers.get("x-middleware-next"),
    ).toBe("1");
    expect((await proxy(new NextRequest("https://dev.example.com/"))).status).toBe(503);
  });

  test("refreshes Auth for non-loopback development", async () => {
    configure({
      AUTH_OWNER_EMAIL: "owner@example.com",
      NODE_ENV: "development",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_URL: "http://127.0.0.1:54321",
    });
    const request = new NextRequest("https://dev.example.com/", {
      headers: { Authorization: `Basic ${btoa(`owner:${password}`)}` },
    });
    mocks.getClaims.mockResolvedValueOnce(validClaims());

    const response = await proxy(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.createServerClient).toHaveBeenCalledWith(
      "http://127.0.0.1:54321",
      publishableKey,
      expect.any(Object),
    );
    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
  });

  test("matches pages and APIs while excluding only static assets", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
  });
});
