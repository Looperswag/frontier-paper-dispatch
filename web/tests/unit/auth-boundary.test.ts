import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireOwner: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth-session", () => ({ requireOwner: mocks.requireOwner }));

import { OwnerAuthError } from "@/lib/auth";
import { authorizeAPI, requireOwnerPage } from "@/lib/auth-boundary";

const owner = Object.freeze({
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
});
const redirectSignal = new Error("NEXT_REDIRECT");

beforeEach(() => {
  mocks.requireOwner.mockReset().mockResolvedValue(owner);
  mocks.redirect.mockReset().mockImplementation(() => {
    throw redirectSignal;
  });
});

describe("business API owner boundary", () => {
  test("returns the minimal verified owner on success", async () => {
    await expect(authorizeAPI()).resolves.toEqual({ ok: true, owner });
  });

  test.each([
    { body: "Authentication required", code: "AUTH_UNAUTHENTICATED", status: 401 },
    { body: "Access forbidden", code: "AUTH_FORBIDDEN", status: 403 },
    { body: "Authentication unavailable", code: "AUTH_UNAVAILABLE", status: 503 },
  ] as const)("maps $code to a generic $status", async ({ body, code, status }) => {
    mocks.requireOwner.mockRejectedValueOnce(new OwnerAuthError(code));

    const result = await authorizeAPI();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(status);
    expect(await result.response.text()).toBe(body);
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    expect(result.response.headers.get("Expires")).toBe("0");
    expect(result.response.headers.get("Pragma")).toBe("no-cache");
    expect(result.response.headers.get("Vary")).toContain("Cookie");
    expect(result.response.headers.get("Vary")).toContain("Origin");
    expect(result.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("maps unexpected verifier failures to a detail-free 503", async () => {
    mocks.requireOwner.mockRejectedValueOnce(
      new Error("private owner@example.com cookie and provider detail"),
    );

    const result = await authorizeAPI();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(await result.response.text()).toBe("Authentication unavailable");
  });
});

describe("private page owner boundary", () => {
  test("returns the verified owner on success", async () => {
    await expect(requireOwnerPage()).resolves.toEqual(owner);
  });

  test.each(["AUTH_UNAUTHENTICATED", "AUTH_FORBIDDEN"] as const)(
    "redirects %s to the fixed login path",
    async (code) => {
      mocks.requireOwner.mockRejectedValueOnce(new OwnerAuthError(code));

      await expect(requireOwnerPage()).rejects.toBe(redirectSignal);
      expect(mocks.redirect).toHaveBeenCalledWith("/login");
    },
  );

  test.each([
    new OwnerAuthError("AUTH_UNAVAILABLE"),
    new Error("private verifier detail"),
  ])("throws only a generic unavailable error for verifier failure", async (failure) => {
    mocks.requireOwner.mockRejectedValueOnce(failure);

    await expect(requireOwnerPage()).rejects.toThrow("Authentication unavailable");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
