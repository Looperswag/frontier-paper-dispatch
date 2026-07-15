import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { proxy } from "@/proxy";
import { MAX_RETURN_TO_BYTES } from "@/lib/return-to";

const originalEnvironment = { ...process.env };
const ownerId = "00000000-0000-4000-8000-000000000701";
const legacyPassword = "legacy-basic-password-with-entropy";

function configureProduction(): void {
  vi.stubEnv("AUTH_OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("DEEPSEEK_API_KEY", `sk-${"d".repeat(40)}`);
  vi.stubEnv("FEEDBACK_SECRET", "f".repeat(40));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RATE_LIMIT_SECRET", "r".repeat(40));
  vi.stubEnv("RATE_LIMIT_SECRET_VERSION", "1");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(40)}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `sb_secret_${"s".repeat(40)}`);
  vi.stubEnv("SUPABASE_URL", "https://frontier-paper.supabase.co");
  vi.stubEnv("WEB_BASE_URL", "https://papers.example.com");
}

function request(
  path = "/",
  options: { basic?: boolean; cookie?: string; method?: string } = {},
): NextRequest {
  return new NextRequest(`https://papers.example.com${path}`, {
    headers: {
      ...(options.basic
        ? { Authorization: `Basic ${btoa(`owner:${legacyPassword}`)}` }
        : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    method: options.method,
  });
}

function expectNoStore(response: Response, noReferrer = false): void {
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("WWW-Authenticate")).toBeNull();
  expect(response.headers.get("Referrer-Policy")).toBe(noReferrer ? "no-referrer" : null);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, noarchive");
}

beforeEach(() => {
  configureProduction();
  mocks.getClaims.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.createServerClient.mockReset().mockReturnValue({
    auth: { getClaims: mocks.getClaims },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.assign(process.env, originalEnvironment);
});

describe("Supabase-session Proxy cutover", () => {
  test("an old correct Basic header grants nothing and an anonymous page goes to login", async () => {
    const withoutBasic = await proxy(request("/paper/one"));
    const withBasic = await proxy(request("/paper/one", { basic: true }));

    for (const response of [withoutBasic, withBasic]) {
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("Location") as string);
      expect(location.origin + location.pathname).toBe("https://papers.example.com/login");
      expect(location.searchParams.get("returnTo")).toBe("/paper/one");
      expectNoStore(response, true);
    }
    expect(mocks.createServerClient).toHaveBeenCalledTimes(2);
    expect(mocks.getClaims).toHaveBeenCalledTimes(2);
  });

  test("an anonymous business API receives a fixed 401 instead of a redirect", async () => {
    const response = await proxy(request("/api/chat", { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Authentication required");
    expectNoStore(response);
  });

  test("treats the bare API namespace as an API instead of a returnable page", async () => {
    const response = await proxy(request("/api?probe=1"));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Authentication required");
    expect(response.headers.get("Location")).toBeNull();
    expectNoStore(response);
  });

  test.each([
    "/API/chat",
    "/%61pi/chat",
    "/%2561pi/chat",
    "/%252561pi/chat",
    "/paper/../api/chat",
    "/%2e%2e/api/chat",
    "/%252e%252e/api/chat",
  ])("keeps an encoded or normalized API path on the fixed 401 branch: %s", async (path) => {
    const response = await proxy(request(path, { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Authentication required");
    expect(response.headers.get("Location")).toBeNull();
    expectNoStore(response);
  });

  test.each([
    `/api/${"a".repeat(MAX_RETURN_TO_BYTES - 4)}`,
    `/%61pi/${"a".repeat(MAX_RETURN_TO_BYTES - 6)}`,
  ])("keeps an oversized API namespace request on the fixed 401 branch", async (path) => {
    expect(new TextEncoder().encode(path)).toHaveLength(MAX_RETURN_TO_BYTES + 1);

    const response = await proxy(request(path, { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Authentication required");
    expect(response.headers.get("Location")).toBeNull();
    expectNoStore(response);
  });

  test("preserves a protected page path and query through the login redirect", async () => {
    const response = await proxy(
      request("/feedback?token=v1_example-token&source=digest"),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location") as string);
    expect(location.origin + location.pathname).toBe("https://papers.example.com/login");
    expect(location.searchParams.get("returnTo")).toBe(
      "/feedback?token=v1_example-token&source=digest",
    );
    expect([...location.searchParams]).toEqual([
      ["returnTo", "/feedback?token=v1_example-token&source=digest"],
    ]);
    expectNoStore(response, true);
  });

  test("builds the production login URL from the validated WEB_BASE_URL, not the request Host", async () => {
    const response = await proxy(
      new NextRequest("https://attacker.example/paper/one?source=host-header"),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location") as string);
    expect(location.origin).toBe("https://papers.example.com");
    expect(location.pathname).toBe("/login");
    expect([...location.searchParams]).toEqual([
      ["returnTo", "/paper/one?source=host-header"],
    ]);
    expectNoStore(response, true);
  });

  test("valid verified claims optimistically continue while final page/API guards remain authoritative", async () => {
    mocks.getClaims.mockResolvedValueOnce({
      data: {
        claims: {
          exp: Math.floor(Date.now() / 1000) + 3600,
          role: "authenticated",
          sub: ownerId,
        },
        header: { alg: "RS256", typ: "JWT" },
        signature: new Uint8Array([1]),
      },
      error: null,
    });

    const response = await proxy(request("/", { cookie: "sb-session=valid" }));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectNoStore(response);
  });

  test.each([
    { code: "session_not_found", status: 401 },
    { code: "refresh_token_not_found", status: 400 },
  ])("maps a known credential failure $code to anonymous", async (authError) => {
    mocks.getClaims.mockResolvedValueOnce({ data: null, error: authError });

    const response = await proxy(request("/api/feedback"));

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Authentication required");
    expectNoStore(response);
  });

  test.each([
    ["unknown Auth error", { data: null, error: { code: "provider_outage", status: 500 } }],
    ["malformed success", { data: { claims: { sub: "not-a-uuid" } }, error: null }],
  ])("fails closed with a generic 503 for %s", async (_name, result) => {
    mocks.getClaims.mockResolvedValueOnce(result);

    const response = await proxy(request("/"));

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Authentication unavailable");
    expectNoStore(response);
  });

  test("fails closed when refresh throws without exposing the cause", async () => {
    mocks.getClaims.mockRejectedValueOnce(new Error("private provider detail"));

    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe("Authentication unavailable");
    expect(body).not.toContain("private provider detail");
    expectNoStore(response);
  });

  test("aborts a hanging Auth transport at the fixed deadline and returns 503", async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        transportSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getClaims.mockImplementationOnce(async () => {
      const options = mocks.createServerClient.mock.calls[0][2] as {
        global: { fetch: typeof fetch };
      };
      await options.global.fetch("https://frontier-paper.supabase.co/auth/v1/user");
      return { data: null, error: null };
    });

    const pending = proxy(request("/"));
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(transportSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoStore(response);
  });

  test("a caller abort ends a never-settling getClaims operation immediately", async () => {
    const controller = new AbortController();
    mocks.getClaims.mockReturnValueOnce(new Promise(() => {}));
    const pending = proxy(
      new NextRequest("https://papers.example.com/", { signal: controller.signal }),
    );

    controller.abort();
    const response = await pending;

    expect(response.status).toBe(503);
    expectNoStore(response);
  });

  test("keeps only exact public Auth methods outside session refresh", async () => {
    for (const [path, method] of [
      ["/login", "GET"],
      ["/login", "HEAD"],
      ["/api/auth/login", "POST"],
      ["/api/auth/logout", "POST"],
    ] as const) {
      const response = await proxy(request(path, { method }));
      expect(response.headers.get("x-middleware-next"), `${method} ${path}`).toBe("1");
      expectNoStore(response, path === "/login");
    }
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  test("contains no Basic authorization implementation after cutover", () => {
    const source = readFileSync(resolve(process.cwd(), "proxy.ts"), "utf8");
    expect(source).not.toMatch(/Basic|WWW-Authenticate|\batob\b|constantTimeEqual/);
  });
});
