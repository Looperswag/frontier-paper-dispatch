import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createServerClient: vi.fn(),
  getAuthConfig: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: (operation: unknown) => operation,
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/lib/config.server", () => ({ getAuthConfig: mocks.getAuthConfig }));

import { OwnerAuthError } from "@/lib/auth";
import { requireOwner } from "@/lib/auth-session";

const ownerId = "00000000-0000-4000-8000-000000000701";
const authConfig = {
  ownerEmail: "owner@example.com",
  publishableKey: `sb_publishable_${"p".repeat(40)}`,
  serviceRoleKey: `sb_secret_${"s".repeat(40)}`,
  url: "https://frontier-paper.supabase.co",
};
const authUser = {
  email: authConfig.ownerEmail,
  email_confirmed_at: "2026-07-12T01:02:03Z",
  id: ownerId,
  is_anonymous: false,
  role: "authenticated",
};

beforeEach(() => {
  mocks.cookies.mockReset().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([{ name: "sb-session", value: "cookie-value" }]),
  });
  mocks.getAuthConfig.mockReset().mockReturnValue(authConfig);
  mocks.getSession.mockReset();
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: authUser }, error: null });
  mocks.createServerClient.mockReset().mockReturnValue({
    auth: { getSession: mocks.getSession, getUser: mocks.getUser },
  });
});

function capture(operation: () => Promise<unknown>): Promise<OwnerAuthError> {
  return operation().then(
    () => {
      throw new Error("expected owner session verification to fail");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OwnerAuthError);
      return error as OwnerAuthError;
    },
  );
}

describe("request owner session verification", () => {
  test("uses only the publishable SSR client, request cookies, and a fresh getUser result", async () => {
    await expect(requireOwner()).resolves.toEqual({
      email: authConfig.ownerEmail,
      userId: ownerId,
    });

    expect(mocks.createServerClient).toHaveBeenCalledWith(
      authConfig.url,
      authConfig.publishableKey,
      expect.objectContaining({ cookies: expect.any(Object) }),
    );
    expect(mocks.createServerClient).not.toHaveBeenCalledWith(
      expect.anything(),
      authConfig.serviceRoleKey,
      expect.anything(),
    );
    const options = mocks.createServerClient.mock.calls[0][2] as {
      cookies: { getAll: () => unknown; setAll?: unknown };
    };
    expect(options.cookies.getAll()).toEqual([{ name: "sb-session", value: "cookie-value" }]);
    expect(options.cookies.setAll).toBeUndefined();
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("preserves a missing-session decision as a generic 401", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: "AuthSessionMissingError", message: "private cookie detail" },
    });

    const error = await capture(() => requireOwner());

    expect(error).toMatchObject({ code: "AUTH_UNAUTHENTICATED", status: 401 });
    expect(String(error)).not.toContain("private cookie detail");
  });

  test("preserves a verified non-owner decision as a generic 403", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { ...authUser, email: "other@example.com" } },
      error: null,
    });

    const error = await capture(() => requireOwner());

    expect(error).toMatchObject({ code: "AUTH_FORBIDDEN", status: 403 });
    expect(String(error)).not.toContain("other@example.com");
  });

  test.each([
    { name: "typed Auth configuration", setup: () => mocks.getAuthConfig.mockImplementationOnce(() => { throw new Error("private config detail"); }) },
    { name: "the request cookie store", setup: () => mocks.cookies.mockRejectedValueOnce(new Error("private cookie detail")) },
    { name: "the Auth network call", setup: () => mocks.getUser.mockRejectedValueOnce(new Error("private network detail")) },
  ])("fails closed with a generic 503 when $name fails", async ({ setup }) => {
    setup();

    const error = await capture(() => requireOwner());

    expect(error).toMatchObject({ code: "AUTH_UNAVAILABLE", status: 503 });
    expect(String(error)).not.toMatch(/private (?:config|cookie|network) detail/);
  });

  test("statically forbids unverified cookie sessions and service-role identity", () => {
    const source = readFileSync("lib/auth-session.ts", "utf8");

    expect(source).not.toMatch(/\.getSession\s*\(/);
    expect(source).not.toMatch(/serviceRole|SERVICE_ROLE/);
  });
});
