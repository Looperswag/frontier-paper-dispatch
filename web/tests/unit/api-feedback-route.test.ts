import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAPI: vi.fn(),
  consumeAPIRateLimit: vi.fn(),
  saveFeedback: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ authorizeAPI: mocks.authorizeAPI }));
vi.mock("@/lib/data", () => ({ saveFeedback: mocks.saveFeedback }));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
}));

import { GET, POST } from "@/app/api/feedback/route";

const itemId = "00000000-0000-4000-8000-000000000001";
const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};

function postRequest(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/feedback", {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...headers,
    },
    method: "POST",
  });
}

async function expectAPIError(response: Response, status: number, code: string) {
  const messages: Record<string, string> = {
    CROSS_ORIGIN_REQUEST: "Cross-origin request denied",
    INTERNAL_ERROR: "Internal error",
    INVALID_REQUEST: "Invalid request",
    NOT_FOUND: "Resource not found",
    PAYLOAD_TOO_LARGE: "Payload too large",
    RATE_LIMITED: "Too many requests",
    SERVICE_UNAVAILABLE: "Service unavailable",
    TOKEN_INVALID_OR_EXPIRED: "Feedback link is invalid or expired",
    UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
  };
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({
    error: { code, message: messages[code] },
    ok: false,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

beforeEach(() => {
  mocks.authorizeAPI.mockReset().mockResolvedValue({
    ok: true,
    owner,
  });
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.saveFeedback.mockReset().mockResolvedValue(undefined);
});

describe("feedback route truthful status", () => {
  test("retires the legacy click-to-write GET without reading or persisting input", async () => {
    const response = await GET(
      new Request(`http://localhost/api/feedback?i=${itemId}&r=up&t=valid-token`),
    );

    await expectAPIError(response, 410, "TOKEN_INVALID_OR_EXPIRED");
    expect(mocks.authorizeAPI).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
    expect(mocks.saveFeedback).not.toHaveBeenCalled();
  });

  test("POST converts persistence failure to a generic 503", async () => {
    mocks.saveFeedback.mockRejectedValueOnce(
      Object.assign(new Error("private database detail"), { code: "DB_OPERATION_FAILED" }),
    );
    const response = await POST(postRequest({ itemId, rating: "down" }));

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
  });

  test("POST returns ok only after persistence", async () => {
    const response = await POST(postRequest({ itemId, rating: "up" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.saveFeedback).toHaveBeenCalledWith(owner, itemId, "up", null);
  });
});

describe("feedback POST request boundary", () => {
  test.each([401, 403, 503])(
    "does not pull the body when authorization returns %i",
    async (status) => {
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
      const response = await POST(
        new Request("http://localhost/api/feedback", {
          body,
          duplex: "half",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          method: "POST",
        } as RequestInit & { duplex: "half" }),
      );

      expect(response.status).toBe(status);
      expect(pulls).toBe(0);
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.saveFeedback).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, "null", "https://attacker.example"])(
    "rejects unsafe Origin %s before pulling the body",
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
      const response = await POST(
        new Request("http://localhost/api/feedback", {
          body,
          duplex: "half",
          headers,
          method: "POST",
        } as RequestInit & { duplex: "half" }),
      );

      await expectAPIError(response, 403, "CROSS_ORIGIN_REQUEST");
      expect(pulls).toBe(0);
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.saveFeedback).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["rate limited", "limited", 429, "RATE_LIMITED", "19"],
    ["quota unavailable", "unavailable", 503, "SERVICE_UNAVAILABLE", null],
  ] as const)(
    "fails closed on %s before pulling a hostile body or persisting feedback",
    async (_name, quotaOutcome, status, code, retryAfter) => {
      if (quotaOutcome === "limited") {
        mocks.consumeAPIRateLimit.mockResolvedValueOnce({
          allowed: false,
          retryAfter: 19,
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
      const request = new Request("http://localhost/api/feedback", {
        body,
        duplex: "half",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        method: "POST",
      } as RequestInit & { duplex: "half" });

      const response = await POST(request);

      await expectAPIError(response, status, code);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(
        request,
        "owner_write",
        owner,
      );
      expect(pulls).toBe(0);
      expect(mocks.saveFeedback).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["missing content type", {}],
    ["wrong content type", { "Content-Type": "text/plain" }],
    ["compressed body", { "Content-Encoding": "gzip" }],
  ])("rejects %s", async (_name, headers) => {
    const request = postRequest({ itemId, rating: "up" }, headers);
    if (_name === "missing content type") request.headers.delete("Content-Type");

    const response = await POST(request);

    await expectAPIError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
    expect(mocks.saveFeedback).not.toHaveBeenCalled();
  });

  test("rejects a declared body above 4 KiB before persistence", async () => {
    const response = await POST(
      postRequest({}, { "Content-Length": "5000" }),
    );

    await expectAPIError(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.saveFeedback).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid UUID", { itemId: "not-a-uuid", rating: "up" }],
    ["invalid rating", { itemId, rating: "maybe" }],
    ["unknown field", { extra: true, itemId, rating: "up" }],
    ["blank note", { itemId, note: "  \n", rating: "up" }],
    ["overlong note", { itemId, note: "a".repeat(501), rating: "up" }],
    ["non-string note", { itemId, note: 7, rating: "up" }],
  ])("rejects %s without persistence", async (_name, payload) => {
    const response = await POST(postRequest(payload));

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.saveFeedback).not.toHaveBeenCalled();
  });

  test("normalizes the UUID and note exactly once before persistence", async () => {
    const uppercase = "ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB";
    const response = await POST(
      postRequest({ itemId: uppercase, note: "  useful context  ", rating: "down" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.saveFeedback).toHaveBeenCalledWith(
      owner,
      uppercase.toLowerCase(),
      "down",
      "useful context",
    );
  });

  test.each([
    ["DB_NOT_FOUND", 404, "NOT_FOUND"],
    ["DB_OPERATION_FAILED", 503, "SERVICE_UNAVAILABLE"],
    ["DB_INTEGRITY_FAILED", 500, "INTERNAL_ERROR"],
    [undefined, 500, "INTERNAL_ERROR"],
  ])("maps persistence failure %s", async (errorCode, status, code) => {
    mocks.saveFeedback.mockRejectedValueOnce(
      Object.assign(
        new Error("private feedback detail"),
        errorCode === undefined ? {} : { code: errorCode },
      ),
    );

    const response = await POST(postRequest({ itemId, rating: "up" }));

    await expectAPIError(response, status, code);
  });
});
