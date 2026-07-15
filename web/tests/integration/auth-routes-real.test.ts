import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeAPIRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";

const originalEnvironment = { ...process.env };
const projectURL = "https://frontier-paper.supabase.co";
const cookieName = "sb-frontier-paper-auth-token";
const ownerId = "00000000-0000-4000-8000-000000000701";
const ownerEmail = "owner@example.com";
const owner = {
  aud: "authenticated",
  created_at: "2026-07-12T01:00:00Z",
  email: ownerEmail,
  email_confirmed_at: "2026-07-12T01:00:00Z",
  id: ownerId,
  is_anonymous: false,
  role: "authenticated",
};

function token(subject = ownerId): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ aud: "authenticated", email: ownerEmail, exp: Math.floor(Date.now() / 1000) + 3600, sub: subject }),
    Buffer.from("test-signature").toString("base64url"),
  ].join(".");
}

function session(suffix: string) {
  return {
    access_token: token(),
    expires_in: 3600,
    refresh_token: `refresh-${suffix}`,
    token_type: "bearer",
    user: owner,
  };
}

function loginRequest(password: string): NextRequest {
  const body = new URLSearchParams({ password }).toString();
  return new NextRequest("https://papers.example.com/api/auth/login", {
    body,
    headers: {
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://papers.example.com",
    },
    method: "POST",
  });
}

function responseCookieHeader(response: NextResponse): string {
  return response.cookies
    .getAll()
    .filter((cookie) => cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function logoutRequest(cookie: string): NextRequest {
  return new NextRequest("https://papers.example.com/api/auth/logout", {
    headers: { Cookie: `${cookie}; sb-other-auth-token=keep`, Origin: "https://papers.example.com" },
    method: "POST",
  });
}

type AuthState = {
  loginBodies: Array<Record<string, unknown>>;
  logoutCalls: number;
  userCalls: number;
};

function installAuthFetch(options: {
  invalidPasswords?: ReadonlySet<string>;
  logoutStatus?: number;
  sessionUser?: typeof owner | Readonly<Record<string, unknown>>;
  verifiedUser?: typeof owner | Readonly<Record<string, unknown>>;
} = {}): AuthState {
  const state: AuthState = { loginBodies: [], logoutCalls: 0, userCalls: 0 };
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${projectURL}/auth/v1/token?grant_type=password`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.loginBodies.push(body);
      const password = String(body.password ?? "");
      if (options.invalidPasswords?.has(password)) {
        return Response.json(
          { code: "invalid_credentials", msg: "private invalid owner detail" },
          { status: 400 },
        );
      }
      return Response.json({ ...session(password), user: options.sessionUser ?? owner });
    }
    if (url === `${projectURL}/auth/v1/user`) {
      state.userCalls += 1;
      return Response.json(options.verifiedUser ?? owner);
    }
    if (url === `${projectURL}/auth/v1/logout?scope=local`) {
      state.logoutCalls += 1;
      return new Response(null, { status: options.logoutStatus ?? 204 });
    }
    return Response.json({ message: "unexpected fake Auth URL" }, { status: 500 });
  });
  vi.stubGlobal("fetch", fakeFetch as typeof fetch);
  return state;
}

beforeEach(() => {
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  vi.stubEnv("AUTH_OWNER_EMAIL", ownerEmail);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(40)}`);
  vi.stubEnv("SUPABASE_URL", projectURL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.assign(process.env, originalEnvironment);
});

describe("real @supabase/ssr password session lifecycle", () => {
  test("creates a verified secure owner cookie with every anti-cache header", async () => {
    const auth = installAuthFetch();

    const response = await login(loginRequest("correct password"));

    expect(response.status).toBe(204);
    expect(auth.loginBodies).toEqual([
      expect.objectContaining({ email: ownerEmail, password: "correct password" }),
    ]);
    expect(auth.userCalls).toBe(1);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${cookieName}=base64-`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
  });

  test("returns a generic 401 and no cookie for a real invalid-credentials response", async () => {
    installAuthFetch({ invalidPasswords: new Set(["wrong password"]) });

    const response = await login(loginRequest("wrong password"));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Authentication failed");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("removes the just-issued cookie when fresh getUser returns a non-owner", async () => {
    installAuthFetch({ verifiedUser: { ...owner, email: "other@example.com" } });

    const response = await login(loginRequest("correct password"));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`${cookieName}=;.*Max-Age=0`, "i"));
    expect(response.headers.get("set-cookie")).not.toContain("refresh-correct");
  });

  test("replays the real login cookie into a local-only logout and clears it", async () => {
    const auth = installAuthFetch();
    const signedIn = await login(loginRequest("correct password"));
    const cookie = responseCookieHeader(signedIn);

    const response = await logout(logoutRequest(cookie));

    expect(auth.logoutCalls).toBe(1);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(response.headers.get("set-cookie")).not.toContain("sb-other-auth-token");
  });

  test("keeps concurrent password sessions request-local", async () => {
    const auth = installAuthFetch();

    const [first, second] = await Promise.all([
      login(loginRequest("session-a")),
      login(loginRequest("session-b")),
    ]);

    expect(auth.loginBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ password: "session-a" }),
        expect.objectContaining({ password: "session-b" }),
      ]),
    );
    expect(first.cookies.get(cookieName)?.value).toContain("base64-");
    expect(second.cookies.get(cookieName)?.value).toContain("base64-");
    expect(first.cookies.get(cookieName)?.value).not.toBe(second.cookies.get(cookieName)?.value);
  });

  test("clears the browser cookie even when remote logout fails", async () => {
    installAuthFetch({ logoutStatus: 500 });
    const signedIn = await login(loginRequest("correct password"));

    const response = await logout(logoutRequest(responseCookieHeader(signedIn)));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Authentication unavailable");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  test("round-trips and removes every real chunk of a large Auth cookie", async () => {
    installAuthFetch({
      sessionUser: {
        ...owner,
        user_metadata: { profile: "x".repeat(9000) },
      },
    });
    const signedIn = await login(loginRequest("large-session"));
    const chunks = signedIn.cookies.getAll().filter((cookie) =>
      cookie.name.startsWith(`${cookieName}.`),
    );

    expect(chunks.length).toBeGreaterThan(1);
    const setCookie = signedIn.headers.get("set-cookie") ?? "";
    expect(setCookie.match(/HttpOnly/gi)?.length).toBe(chunks.length);
    expect(setCookie.match(/SameSite=Lax/gi)?.length).toBe(chunks.length);

    const signedOut = await logout(logoutRequest(responseCookieHeader(signedIn)));

    const removed = signedOut.cookies
      .getAll()
      .filter((cookie) => cookie.name.startsWith(`${cookieName}.`));
    expect(removed.map((cookie) => cookie.name).sort()).toEqual(
      chunks.map((cookie) => cookie.name).sort(),
    );
    expect(removed.every((cookie) => cookie.value === "")).toBe(true);
    expect(signedOut.headers.get("set-cookie")?.match(/Max-Age=0/gi)?.length).toBe(
      chunks.length,
    );
  });
});
