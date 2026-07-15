import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearAuthCookiesAtScopes: vi.fn(),
  consumeAPIRateLimit: vi.fn(),
  createServerClient: vi.fn(),
  getAuthConfig: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/ssr", () => ({
  clearAuthCookiesAtScopes: mocks.clearAuthCookiesAtScopes,
  createServerClient: mocks.createServerClient,
}));
vi.mock("@/lib/config.server", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";

const ownerId = "00000000-0000-4000-8000-000000000701";
const ownerEmail = "owner@example.com";
const publishableKey = `sb_publishable_${"p".repeat(40)}`;
const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const projectURL = "https://frontier-paper.supabase.co";
const cookieName = "sb-frontier-paper-auth-token";
const owner = {
  email: ownerEmail,
  email_confirmed_at: "2026-07-12T01:02:03Z",
  id: ownerId,
  is_anonymous: false,
  role: "authenticated",
};

type CookieMethods = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (
    cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>,
    headers: Record<string, string>,
  ) => void | Promise<void>;
};

let cookieMethods: CookieMethods;

function loginRequest(
  password = " owner password with spaces ",
  options: {
    body?: string;
    contentLength?: string;
    contentType?: string;
    host?: string;
    origin?: string;
    requestURL?: string;
  } = {},
): NextRequest {
  const body = options.body ?? new URLSearchParams({ password }).toString();
  return new NextRequest(options.requestURL ?? "https://papers.example.com/api/auth/login", {
    body,
    headers: {
      "Content-Length": options.contentLength ?? String(new TextEncoder().encode(body).byteLength),
      "Content-Type": options.contentType ?? "application/x-www-form-urlencoded",
      ...(options.host ? { Host: options.host } : {}),
      ...(options.origin === undefined ? { Origin: "https://papers.example.com" } : options.origin ? { Origin: options.origin } : {}),
    },
    method: "POST",
  });
}

function logoutRequest(
  options: { cookie?: string; origin?: string } = {},
): NextRequest {
  return new NextRequest("https://papers.example.com/api/auth/logout", {
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin === undefined ? { Origin: "https://papers.example.com" } : options.origin ? { Origin: options.origin } : {}),
    },
    method: "POST",
  });
}

beforeEach(() => {
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.getAuthConfig.mockReset().mockReturnValue({
    ownerEmail,
    publishableKey,
    serviceRoleKey,
    url: projectURL,
  });
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: owner }, error: null });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.signInWithPassword.mockReset().mockImplementation(async () => {
    const options = mocks.createServerClient.mock.calls.at(-1)?.[2] as {
      cookieOptions: Record<string, unknown>;
    };
    await cookieMethods.setAll(
      [
        {
          name: cookieName,
          options: { ...options.cookieOptions, maxAge: 3600 },
          value: "encoded-owner-session",
        },
      ],
      {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        Expires: "0",
        Pragma: "no-cache",
      },
    );
    return { data: { session: { access_token: "opaque" }, user: owner }, error: null };
  });
  mocks.createServerClient.mockReset().mockImplementation((_url, _key, options) => {
    cookieMethods = options.cookies as CookieMethods;
    return {
      auth: {
        getUser: mocks.getUser,
        signInWithPassword: mocks.signInWithPassword,
        signOut: mocks.signOut,
      },
    };
  });
  mocks.clearAuthCookiesAtScopes.mockReset().mockImplementation(async (options) => {
    const cookies = (await options.getAll([options.storageKey])) as Array<{
      name: string;
      value: string;
    }>;
    await options.setAll(
      cookies
        .filter((cookie) => cookie.name === options.storageKey || cookie.name.startsWith(`${options.storageKey}.`))
        .map((cookie) => ({
          name: cookie.name,
          options: { ...options.scopes[0], maxAge: 0 },
          value: "",
        })),
      {},
    );
  });
});

describe("password login route", () => {
  test.each(["", "null", "https://evil.example.com", "https://papers.example.com:444"])(
    "rejects an unsafe Origin %j before constructing an Auth client",
    async (origin) => {
      const response = await login(loginRequest(undefined, { origin }));

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.createServerClient).not.toHaveBeenCalled();
    },
  );

  test("compares Origin with the externally forwarded Host rather than an internal Next URL", async () => {
    const response = await login(
      loginRequest("password", {
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
        requestURL: "http://localhost:3100/api/auth/login",
      }),
    );

    expect(response.status).toBe(204);
  });

  test("does not trust a conflicting X-Forwarded-Host over the request Host", async () => {
    const body = "password=secret";
    const response = await login(
      new NextRequest("https://internal.example.com/api/auth/login", {
        body,
        headers: {
          "Content-Length": String(body.length),
          "Content-Type": "application/x-www-form-urlencoded",
          Host: "papers.example.com",
          Origin: "https://evil.example.com",
          "X-Forwarded-Host": "evil.example.com",
          "X-Forwarded-Proto": "https",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  test("returns the distributed login decision before pulling the body or constructing Auth", async () => {
    mocks.consumeAPIRateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfter: 347,
    });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("password=hostile"));
        controller.close();
      },
    });
    const request = new NextRequest("https://papers.example.com/api/auth/login", {
      body,
      duplex: "half",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://papers.example.com",
      },
      method: "POST",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

    const response = await login(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("347");
    expect(await response.text()).toBe("Authentication temporarily unavailable");
    expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(request, "auth_login");
    expect(pulls).toBe(0);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  test("fails closed before pulling the body or constructing Auth when login quota is unavailable", async () => {
    mocks.consumeAPIRateLimit.mockRejectedValueOnce(
      new Error("private distributed quota detail"),
    );
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("password=hostile"));
        controller.close();
      },
    });
    const request = new NextRequest("https://papers.example.com/api/auth/login", {
      body,
      duplex: "half",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://papers.example.com",
      },
      method: "POST",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

    const response = await login(request);
    const responseBody = await response.text();

    expect(response.status).toBe(503);
    expect(responseBody).toBe("Authentication unavailable");
    expect(responseBody).not.toContain("quota");
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(request, "auth_login");
    expect(pulls).toBe(0);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  test("cancels an undeclared oversized request stream before buffering the full body", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls > 12) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024).fill(97));
      },
    });
    const streamInit = {
      body,
      duplex: "half",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://papers.example.com",
      },
      method: "POST",
    } as unknown as ConstructorParameters<typeof NextRequest>[1];
    const request = new NextRequest(
      "https://papers.example.com/api/auth/login",
      streamInit,
    );

    const response = await login(request);

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(13);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "wrong content type",
      request: () => loginRequest(undefined, { contentType: "application/json" }),
    },
    {
      name: "declared oversized body",
      request: () => loginRequest(undefined, { contentLength: "4097" }),
    },
    {
      name: "empty password",
      request: () => loginRequest(undefined, { body: "password=" }),
    },
    {
      name: "duplicate password",
      request: () => loginRequest(undefined, { body: "password=one&password=two" }),
    },
    {
      name: "client-supplied owner email",
      request: () => loginRequest(undefined, { body: "password=secret&email=other%40example.com" }),
    },
    {
      name: "client-supplied redirect",
      request: () => loginRequest(undefined, { body: "password=secret&next=https%3A%2F%2Fevil.example" }),
    },
  ])("rejects $name before Auth", async ({ request }) => {
    const response = await login(request());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request");
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  test("uses only the configured owner, unchanged password, and publishable request client", async () => {
    const password = " owner password with spaces ";

    const response = await login(loginRequest(password));

    expect(response.status).toBe(204);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: ownerEmail, password });
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.createServerClient).toHaveBeenCalledWith(
      projectURL,
      publishableKey,
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: true,
        }),
      }),
    );
    expect(mocks.createServerClient).not.toHaveBeenCalledWith(
      expect.anything(),
      serviceRoleKey,
      expect.anything(),
    );
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  test("maps invalid credentials to a detail-free 401 without verifying a user", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", message: "owner account exists", status: 400 },
    });

    const response = await login(loginRequest("wrong password"));

    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).toBe("Authentication failed");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(body).not.toMatch(/owner|exists|invalid_credentials/);
  });

  test("clears a newly issued session when fresh verification is not the owner", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { ...owner, email: "other@example.com" } },
      error: null,
    });

    const response = await login(loginRequest());

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication failed");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.clearAuthCookiesAtScopes).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(response.headers.get("set-cookie")).not.toContain("encoded-owner-session");
  });

  test("preserves rate limiting without leaking the upstream response", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "over_request_rate_limit", message: "private quota detail", status: 429 },
    });

    const response = await login(loginRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.text()).toBe("Authentication temporarily unavailable");
  });

  test("maps configuration and Auth exceptions to a detail-free 503", async () => {
    mocks.getAuthConfig.mockImplementationOnce(() => {
      throw new Error("private owner@example.com config detail");
    });

    const response = await login(loginRequest());

    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe("Authentication unavailable");
    expect(body).not.toContain(ownerEmail);
  });

  test("bounds a hanging password exchange", async () => {
    vi.useFakeTimers();
    try {
      mocks.signInWithPassword.mockReturnValueOnce(new Promise(() => {}));

      const pending = login(loginRequest());
      const observed = Promise.race([
        pending,
        new Promise<"deadline-missed">((resolve) =>
          setTimeout(() => resolve("deadline-missed"), 20_000),
        ),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await observed;

      expect(response).not.toBe("deadline-missed");
      if (response === "deadline-missed") return;
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Authentication unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds hanging fresh verification and removes the issued cookie", async () => {
    vi.useFakeTimers();
    try {
      mocks.getUser.mockReturnValueOnce(new Promise(() => {}));

      const pending = login(loginRequest());
      const observed = Promise.race([
        pending,
        new Promise<"deadline-missed">((resolve) =>
          setTimeout(() => resolve("deadline-missed"), 20_000),
        ),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await observed;

      expect(response).not.toBe("deadline-missed");
      if (response === "deadline-missed") return;
      expect(response.status).toBe(503);
      expect(mocks.clearAuthCookiesAtScopes).toHaveBeenCalledTimes(1);
      expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("local-session logout route", () => {
  test("requires the same Origin before touching the session", async () => {
    const response = await logout(logoutRequest({ origin: "https://evil.example.com" }));

    expect(response.status).toBe(403);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  test("signs out only this session, clears only this project, and redirects relatively", async () => {
    const response = await logout(
      logoutRequest({
        cookie: `${cookieName}.0=chunk-zero; ${cookieName}.1=chunk-one; sb-other-auth-token=keep`,
      }),
    );

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.clearAuthCookiesAtScopes).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: cookieName,
        scopes: [
          expect.objectContaining({ httpOnly: true, path: "/", sameSite: "lax", secure: true }),
        ],
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`${cookieName}\\.0=;.*Max-Age=0`, "i"));
    expect(response.headers.get("set-cookie")).not.toContain("sb-other-auth-token");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
  });

  test("still clears local cookies but reports a remote revoke failure generically", async () => {
    mocks.signOut.mockResolvedValueOnce({
      error: { message: "private revoke detail", status: 500 },
    });

    const response = await logout(logoutRequest({ cookie: `${cookieName}=session` }));

    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe("Authentication unavailable");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(body).not.toContain("private revoke detail");
  });

  test("bounds a hanging remote revoke before clearing the browser cookie", async () => {
    vi.useFakeTimers();
    try {
      mocks.signOut.mockReturnValueOnce(new Promise(() => {}));

      const pending = logout(logoutRequest({ cookie: `${cookieName}=session` }));
      const observed = Promise.race([
        pending,
        new Promise<"deadline-missed">((resolve) =>
          setTimeout(() => resolve("deadline-missed"), 20_000),
        ),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await observed;

      expect(response).not.toBe("deadline-missed");
      if (response === "deadline-missed") return;
      expect(response.status).toBe(503);
      expect(mocks.clearAuthCookiesAtScopes).toHaveBeenCalledTimes(1);
      expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

test("Auth route sources exclude unverified sessions, admin credentials, and secret logging", () => {
  const source = [
    readFileSync("app/api/auth/login/route.ts", "utf8"),
    readFileSync("app/api/auth/logout/route.ts", "utf8"),
    readFileSync("lib/auth-http.ts", "utf8"),
  ].join("\n");

  expect(source).not.toMatch(/\.getSession\s*\(/);
  expect(source).not.toMatch(/serviceRole|SERVICE_ROLE|console\.(?:log|debug|info)/);
  expect(source).not.toContain(ownerEmail);
});
