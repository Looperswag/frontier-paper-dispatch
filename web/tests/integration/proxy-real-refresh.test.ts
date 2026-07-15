import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { proxy } from "@/proxy";

const originalEnvironment = { ...process.env };
const password = "integration-private-password";
const ownerId = "00000000-0000-4000-8000-000000000701";
const projectURL = "https://frontier-paper.supabase.co";
const cookieName = "sb-frontier-paper-auth-token";
const owner = {
  aud: "authenticated",
  created_at: "2026-07-12T01:00:00Z",
  email: "owner@example.com",
  email_confirmed_at: "2026-07-12T01:00:00Z",
  id: ownerId,
  is_anonymous: false,
  role: "authenticated",
};

function token(expiresAt: number, subject = ownerId): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      aud: "authenticated",
      email: owner.email,
      exp: expiresAt,
      is_anonymous: false,
      role: "authenticated",
      sub: subject,
    }),
    Buffer.from("test-signature").toString("base64url"),
  ].join(".");
}

function sessionCookie(refreshToken: string, expiresAt: number): string {
  const session = {
    access_token: token(expiresAt),
    expires_at: expiresAt,
    expires_in: 3600,
    refresh_token: refreshToken,
    token_type: "bearer",
    user: owner,
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function request(cookie?: string): NextRequest {
  return new NextRequest("https://papers.example.com/paper/one", {
    headers: {
      Authorization: `Basic ${btoa(`owner:${password}`)}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

function responseCookieHeader(response: NextResponse): string {
  return response.cookies
    .getAll()
    .filter((cookie) => cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function decodedResponseSession(response: NextResponse): Record<string, unknown> | undefined {
  const value = response.cookies.get(cookieName)?.value;
  if (!value?.startsWith("base64-")) return undefined;
  return JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

type AuthFetchState = {
  rejectedUserCalls: number;
  refreshBodies: Array<Record<string, unknown>>;
  userCalls: number;
};

function installAuthFetch(options: { revoked?: ReadonlySet<string> } = {}): AuthFetchState {
  const state: AuthFetchState = { refreshBodies: [], rejectedUserCalls: 0, userCalls: 0 };
  const issuedAccessTokens = new Set<string>();
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${projectURL}/auth/v1/token?grant_type=refresh_token`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.refreshBodies.push(body);
      const refreshToken = String(body.refresh_token ?? "");
      if (options.revoked?.has(refreshToken)) {
        return Response.json(
          { code: "refresh_token_not_found", msg: "revoked private detail" },
          { status: 400 },
        );
      }
      const suffix = refreshToken.replace(/^refresh-/, "") || "next";
      const subjectSuffix = /^[0-9a-f]$/i.test(suffix.at(-1) ?? "")
        ? (suffix.at(-1) as string)
        : "1";
      const accessToken = token(
        Math.floor(Date.now() / 1000) + 3600,
        `${ownerId.slice(0, -1)}${subjectSuffix}`,
      );
      issuedAccessTokens.add(accessToken);
      return Response.json({
        access_token: accessToken,
        expires_in: 3600,
        refresh_token: `rotated-${suffix}`,
        token_type: "bearer",
        user: owner,
      });
    }
    if (url === `${projectURL}/auth/v1/user`) {
      state.userCalls += 1;
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
      const accessToken = headers.get("Authorization")?.replace(/^Bearer /, "");
      if (!accessToken || !issuedAccessTokens.has(accessToken)) {
        state.rejectedUserCalls += 1;
        return Response.json({ code: "bad_jwt", message: "test token rejected" }, { status: 401 });
      }
      return Response.json(owner);
    }
    return Response.json({ message: "unexpected fake Auth URL" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fakeFetch as typeof fetch);
  return state;
}

beforeEach(() => {
  vi.stubEnv("AUTH_OWNER_EMAIL", owner.email);
  vi.stubEnv("DEEPSEEK_API_KEY", `sk-${"d".repeat(40)}`);
  vi.stubEnv("FEEDBACK_SECRET", "f".repeat(40));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RATE_LIMIT_SECRET", "r".repeat(40));
  vi.stubEnv("RATE_LIMIT_SECRET_VERSION", "1");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(40)}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `sb_secret_${"s".repeat(40)}`);
  vi.stubEnv("SUPABASE_URL", projectURL);
  vi.stubEnv("WEB_BASE_URL", "https://papers.example.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.assign(process.env, originalEnvironment);
});

describe("real @supabase/ssr Proxy refresh integration", () => {
  test("refreshes an expired cookie once, propagates cache headers, and reuses the rotation", async () => {
    const auth = installAuthFetch();
    const expired = Math.floor(Date.now() / 1000) - 60;

    const first = await proxy(request(`${cookieName}=${sessionCookie("refresh-first", expired)}`));

    expect(auth.refreshBodies).toEqual([{ refresh_token: "refresh-first" }]);
    expect(decodedResponseSession(first)).toMatchObject({ refresh_token: "rotated-first" });
    expect(first.headers.get("Cache-Control")).toContain("private");
    expect(first.headers.get("Expires")).toBe("0");
    expect(first.headers.get("Pragma")).toBe("no-cache");

    const second = await proxy(request(responseCookieHeader(first)));

    expect(second.headers.get("x-middleware-next")).toBe("1");
    expect(auth.refreshBodies).toHaveLength(1);
    expect(auth.userCalls).toBe(2);
  });

  test("keeps separate expired-cookie requests isolated", async () => {
    const auth = installAuthFetch();
    const expired = Math.floor(Date.now() / 1000) - 60;

    const [first, second] = await Promise.all([
      proxy(request(`${cookieName}=${sessionCookie("refresh-a", expired)}`)),
      proxy(request(`${cookieName}=${sessionCookie("refresh-b", expired)}`)),
    ]);

    expect(auth.refreshBodies).toEqual(
      expect.arrayContaining([{ refresh_token: "refresh-a" }, { refresh_token: "refresh-b" }]),
    );
    expect(decodedResponseSession(first)?.refresh_token).toBe("rotated-a");
    expect(decodedResponseSession(second)?.refresh_token).toBe("rotated-b");
  });

  test("clears a revoked refresh cookie and does not retry after the browser applies removal", async () => {
    const auth = installAuthFetch({ revoked: new Set(["refresh-revoked"]) });
    const expired = Math.floor(Date.now() / 1000) - 60;

    const first = await proxy(
      request(`${cookieName}=${sessionCookie("refresh-revoked", expired)}`),
    );

    expect(auth.refreshBodies).toEqual([{ refresh_token: "refresh-revoked" }]);
    expect(first.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(first.headers.get("Cache-Control")).toContain("no-store");

    await proxy(request());

    expect(auth.refreshBodies).toHaveLength(1);
  });

  test("rejects a well-shaped but unissued bearer instead of trusting the fixture", async () => {
    const auth = installAuthFetch();
    const future = Math.floor(Date.now() / 1000) + 3600;

    const response = await proxy(
      request(`${cookieName}=${sessionCookie("unissued-refresh", future)}`),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location") as string);
    expect(location.origin + location.pathname).toBe("https://papers.example.com/login");
    expect(location.searchParams.get("returnTo")).toBe("/paper/one");
    expect(auth.userCalls).toBe(1);
    expect(auth.rejectedUserCalls).toBe(1);
  });
});
