import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAPI: vi.fn(),
  consumeAPIRateLimit: vi.fn(),
  redeemFeedbackToken: vi.fn(),
  verifyFeedbackToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ authorizeAPI: mocks.authorizeAPI }));
vi.mock("@/lib/data", () => ({ redeemFeedbackToken: mocks.redeemFeedbackToken }));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
}));
vi.mock("@/lib/sign", () => ({ verifyFeedbackToken: mocks.verifyFeedbackToken }));

import { POST } from "@/app/api/feedback/redeem/route";

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};
const claims = Object.freeze({
  digestDate: "2026-07-13",
  expiresAt: 1_785_772_800,
  itemId: "00000000-0000-4000-8000-000000000001",
  nonce: "n".repeat(43),
  rating: "up" as const,
  version: "v1" as const,
});
const token = `v1.${"t".repeat(120)}`;

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/feedback/redeem", {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...headers,
    },
    method: "POST",
  });
}

async function expectError(response: Response, status: number, code: string, message: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({
    error: { code, message },
    ok: false,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

beforeEach(() => {
  mocks.authorizeAPI.mockReset().mockResolvedValue({ ok: true, owner });
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.verifyFeedbackToken.mockReset().mockReturnValue(claims);
  mocks.redeemFeedbackToken.mockReset().mockResolvedValue({
    digestDate: claims.digestDate,
    feedbackId: "00000000-0000-4000-8000-000000000301",
    itemId: claims.itemId,
    ok: true,
    rating: claims.rating,
    redeemedAt: "2026-07-13T01:00:00Z",
  });
});

describe("one-time feedback redemption route", () => {
  test.each([401, 403, 503])("authorizes before reading a hostile body (%i)", async (status) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("hostile"));
        controller.close();
      },
    });
    mocks.authorizeAPI.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status }),
    });

    const response = await POST(new Request("http://localhost/api/feedback/redeem", {
      body,
      duplex: "half",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      method: "POST",
    } as RequestInit & { duplex: "half" }));

    expect(response.status).toBe(status);
    expect(pulls).toBe(0);
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
    expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
    expect(mocks.redeemFeedbackToken).not.toHaveBeenCalled();
  });

  test.each([undefined, "null", "https://attacker.example"])(
    "rejects unsafe Origin %s before reading the body",
    async (origin) => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("hostile"));
          controller.close();
        },
      });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (origin !== undefined) headers.Origin = origin;

      const response = await POST(new Request("http://localhost/api/feedback/redeem", {
        body,
        duplex: "half",
        headers,
        method: "POST",
      } as RequestInit & { duplex: "half" }));

      await expectError(response, 403, "CROSS_ORIGIN_REQUEST", "Cross-origin request denied");
      expect(pulls).toBe(0);
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["rate limited", "limited", 429, "RATE_LIMITED", "Too many requests", "29"],
    [
      "quota unavailable",
      "unavailable",
      503,
      "SERVICE_UNAVAILABLE",
      "Service unavailable",
      null,
    ],
  ] as const)(
    "fails closed on %s before pulling a hostile body, verification, or redemption",
    async (_name, quotaOutcome, status, code, message, retryAfter) => {
      if (quotaOutcome === "limited") {
        mocks.consumeAPIRateLimit.mockResolvedValueOnce({
          allowed: false,
          retryAfter: 29,
        });
      } else {
        mocks.consumeAPIRateLimit.mockRejectedValueOnce(
          new Error("private quota backend detail"),
        );
      }
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("hostile"));
          controller.close();
        },
      });
      const request = new Request("http://localhost/api/feedback/redeem", {
        body,
        duplex: "half",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        method: "POST",
      } as RequestInit & { duplex: "half" });

      const response = await POST(request);

      await expectError(response, status, code, message);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(
        request,
        "owner_write",
        owner,
      );
      expect(pulls).toBe(0);
      expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
      expect(mocks.redeemFeedbackToken).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["unknown field", { extra: true, token }],
    ["missing token", {}],
    ["empty token", { token: "" }],
    ["non-string token", { token: 7 }],
    ["oversized token", { token: "x".repeat(257) }],
  ])("rejects %s", async (_name, payload) => {
    const response = await POST(request(payload));

    await expectError(response, 400, "INVALID_REQUEST", "Invalid request");
    expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
    expect(mocks.redeemFeedbackToken).not.toHaveBeenCalled();
  });

  test.each([
    ["wrong media type", { "Content-Type": "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported media type"],
    ["compressed body", { "Content-Encoding": "gzip" }, 415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported media type"],
    ["declared too large", { "Content-Length": "5000" }, 413, "PAYLOAD_TOO_LARGE", "Payload too large"],
  ])("rejects %s", async (_name, headers, status, code, message) => {
    const response = await POST(request({ token }, headers as Record<string, string>));

    await expectError(response, status as number, code as string, message as string);
    expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
  });

  test("does not redeem an invalid or expired token", async () => {
    mocks.verifyFeedbackToken.mockReturnValueOnce(undefined);

    const response = await POST(request({ token }));

    await expectError(
      response,
      410,
      "TOKEN_INVALID_OR_EXPIRED",
      "Feedback link is invalid or expired",
    );
    expect(mocks.verifyFeedbackToken).toHaveBeenCalledWith(token);
    expect(mocks.redeemFeedbackToken).not.toHaveBeenCalled();
  });

  test("treats missing verification configuration as an unavailable service", async () => {
    mocks.verifyFeedbackToken.mockImplementationOnce(() => {
      throw new Error("private feedback secret detail");
    });

    const response = await POST(request({ token }));

    await expectError(response, 503, "SERVICE_UNAVAILABLE", "Service unavailable");
    expect(mocks.redeemFeedbackToken).not.toHaveBeenCalled();
  });

  test("redeems exactly once only after verification", async () => {
    const response = await POST(request({ token }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, rating: "up" });
    expect(mocks.verifyFeedbackToken).toHaveBeenCalledWith(token);
    expect(mocks.redeemFeedbackToken).toHaveBeenCalledWith(owner, claims);
  });

  test.each([
    ["already_redeemed", 409, "FEEDBACK_ALREADY_REDEEMED", "Feedback was already recorded"],
    ["expired", 410, "TOKEN_INVALID_OR_EXPIRED", "Feedback link is invalid or expired"],
    ["invalid_context", 410, "TOKEN_INVALID_OR_EXPIRED", "Feedback link is invalid or expired"],
  ] as const)("maps %s without manufacturing success", async (reason, status, code, message) => {
    mocks.redeemFeedbackToken.mockResolvedValueOnce({ ok: false, reason });

    const response = await POST(request({ token }));

    await expectError(response, status, code, message);
  });

  test.each([
    ["DB_OPERATION_FAILED", 503, "SERVICE_UNAVAILABLE", "Service unavailable"],
    ["DB_INTEGRITY_FAILED", 500, "INTERNAL_ERROR", "Internal error"],
    [undefined, 500, "INTERNAL_ERROR", "Internal error"],
  ])("maps database error %s", async (errorCode, status, code, message) => {
    mocks.redeemFeedbackToken.mockRejectedValueOnce(
      Object.assign(new Error("private database detail"), errorCode ? { code: errorCode } : {}),
    );

    const response = await POST(request({ token }));

    await expectError(response, status as number, code as string, message as string);
  });
});
