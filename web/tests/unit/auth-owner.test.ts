import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OwnerAuthError, ownerFromAuthResult } from "@/lib/auth";

const ownerEmail = "owner@example.com";
const ownerId = "00000000-0000-4000-8000-000000000701";

function user(overrides: Record<string, unknown> = {}) {
  return {
    email: ownerEmail,
    email_confirmed_at: "2026-07-12T01:02:03.000Z",
    id: ownerId,
    is_anonymous: false,
    role: "authenticated",
    ...overrides,
  };
}

function result(currentUser: unknown, error: unknown = null) {
  return { data: { user: currentUser }, error };
}

function capture(operation: () => unknown): OwnerAuthError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAuthError);
    return error as OwnerAuthError;
  }
  throw new Error("expected owner authorization to fail");
}

describe("single-owner authorization decision", () => {
  test("returns a minimal frozen owner context after normalized exact-email authorization", () => {
    const owner = ownerFromAuthResult(
      result(user({ email: "Owner@Example.COM", id: ownerId.toUpperCase() })),
      " OWNER@example.com ",
    );

    expect(owner).toEqual({ email: ownerEmail, userId: ownerId });
    expect(Object.isFrozen(owner)).toBe(true);
    expect(owner).not.toHaveProperty("user_metadata");
  });

  test("accepts a valid microsecond confirmation timestamp with a bounded offset", () => {
    expect(
      ownerFromAuthResult(
        result(user({ email_confirmed_at: "2026-07-12T09:02:03.123456+08:00" })),
        ownerEmail,
      ),
    ).toMatchObject({ email: ownerEmail, userId: ownerId });
  });

  test.each([
    {
      name: "a missing session",
      result: result(null, { name: "AuthSessionMissingError", message: "private detail" }),
    },
    {
      name: "an invalid JWT",
      result: result(null, { code: "bad_jwt", message: "private detail", status: 401 }),
    },
    ...["no_authorization", "session_expired", "unexpected_audience", "user_not_found"].map((code) => ({
      name: code,
      result: result(null, { code, message: "private detail", status: 400 }),
    })),
  ])("maps $name to a generic 401", ({ result: authResult }) => {
    const error = capture(() => ownerFromAuthResult(authResult, ownerEmail));

    expect(error).toMatchObject({ code: "AUTH_UNAUTHENTICATED", status: 401 });
    expect(String(error)).not.toContain("private detail");
  });

  test.each(["email_not_confirmed", "provider_email_needs_verification", "user_banned"])(
    "maps provider code %s to a generic 403",
    (code) => {
      const error = capture(() =>
        ownerFromAuthResult(
          result(null, { code, message: "private forbidden detail", status: 403 }),
          ownerEmail,
        ),
      );

      expect(error).toMatchObject({ code: "AUTH_FORBIDDEN", status: 403 });
      expect(String(error)).not.toContain("private forbidden detail");
    },
  );

  test.each([
    { name: "a different email", user: user({ email: "other@example.com" }) },
    { name: "no email", user: user({ email: undefined }) },
    { name: "an invalid email", user: user({ email: "not-an-email" }) },
    { name: "an unconfirmed email", user: user({ email_confirmed_at: undefined }) },
    { name: "an anonymous user", user: user({ is_anonymous: true }) },
    { name: "a non-authenticated role", user: user({ role: "service_role" }) },
    {
      name: "metadata impersonation",
      user: user({ email: "other@example.com", user_metadata: { email: ownerEmail } }),
    },
  ])("maps $name to a generic 403", ({ user: authUser }) => {
    const error = capture(() => ownerFromAuthResult(result(authUser), ownerEmail));

    expect(error).toMatchObject({ code: "AUTH_FORBIDDEN", status: 403 });
    expect(String(error)).not.toContain("other@example.com");
  });

  test.each([
    {
      name: "an Auth service failure",
      result: result(null, { message: "provider-secret-sentinel", status: 503 }),
    },
    { name: "a null user without an Auth error", result: result(null) },
    { name: "a malformed response", result: { data: null, error: null } },
    { name: "a malformed user id", result: result(user({ id: "not-a-uuid" })) },
    {
      name: "a malformed confirmation timestamp",
      result: result(user({ email_confirmed_at: "not-a-time" })),
    },
    {
      name: "an impossible confirmation date",
      result: result(user({ email_confirmed_at: "2026-02-31T01:02:03Z" })),
    },
    {
      name: "a 24-hour confirmation time",
      result: result(user({ email_confirmed_at: "2026-07-12T24:00:00Z" })),
    },
    {
      name: "an astronomical year-zero confirmation",
      result: result(user({ email_confirmed_at: "0000-07-12T01:02:03Z" })),
    },
    ...[undefined, null, "false"].map((is_anonymous) => ({
      name: `a malformed anonymous flag ${String(is_anonymous)}`,
      result: result(user({ is_anonymous })),
    })),
    ...[undefined, null, 123].map((role) => ({
      name: `a malformed role ${String(role)}`,
      result: result(user({ role })),
    })),
  ])("fails closed with a generic 503 for $name", ({ result: authResult }) => {
    const error = capture(() => ownerFromAuthResult(authResult, ownerEmail));

    expect(error).toMatchObject({ code: "AUTH_UNAVAILABLE", status: 503 });
    expect(String(error)).not.toContain("provider-secret-sentinel");
  });

  test("fails closed when the configured owner email is invalid", () => {
    const error = capture(() => ownerFromAuthResult(result(user()), "invalid-owner"));

    expect(error).toMatchObject({ code: "AUTH_UNAVAILABLE", status: 503 });
  });
});
