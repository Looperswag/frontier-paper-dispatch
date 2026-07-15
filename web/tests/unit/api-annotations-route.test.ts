import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAnnotation: vi.fn(),
  authorizeAPI: vi.fn(),
  consumeAPIRateLimit: vi.fn(),
  deleteAnnotation: vi.fn(),
  getAnnotations: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ authorizeAPI: mocks.authorizeAPI }));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
}));
vi.mock("@/lib/data", () => ({
  addAnnotation: mocks.addAnnotation,
  deleteAnnotation: mocks.deleteAnnotation,
  getAnnotations: mocks.getAnnotations,
}));

import { DELETE, GET, POST } from "@/app/api/annotations/route";

const itemId = "00000000-0000-4000-8000-000000000001";
const annotationId = "00000000-0000-4000-8000-000000000101";
const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};
const annotation = {
  anchor: { x: 1, y: 2 },
  body: "note",
  color: "#e0c060",
  id: annotationId,
  type: "note" as const,
};

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/annotations", {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...headers,
    },
    method: "POST",
  });
}

function deleteRequest(query = `id=${annotationId}`, origin = "http://localhost") {
  return new Request(`http://localhost/api/annotations?${query}`, {
    headers: { Origin: origin },
    method: "DELETE",
  });
}

async function expectAPIError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({
    error: { code },
    ok: false,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

function databaseError(code: string) {
  return Object.assign(new Error("private database detail"), { code });
}

beforeEach(() => {
  mocks.authorizeAPI.mockReset().mockResolvedValue({
    ok: true,
    owner,
  });
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.addAnnotation.mockReset().mockResolvedValue(annotation);
  mocks.deleteAnnotation.mockReset().mockResolvedValue(undefined);
  mocks.getAnnotations.mockReset().mockResolvedValue([annotation]);
});

describe("annotation route truthful status", () => {
  test("GET returns 400 rather than a manufactured empty list without itemId", async () => {
    const response = await GET(new Request("http://localhost/api/annotations"));

    expect(response.status).toBe(400);
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
  });

  test("GET maps a database operation failure to a generic 503", async () => {
    mocks.getAnnotations.mockRejectedValueOnce(databaseError("DB_OPERATION_FAILED"));
    const response = await GET(
      new Request(`http://localhost/api/annotations?itemId=${itemId}`),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database detail");
  });

  test("POST returns 201 only for the persisted DTO", async () => {
    const response = await POST(
      jsonRequest({
        anchor: { x: 1, y: 2 },
        body: "note",
        color: "#e0c060",
        itemId,
        type: "note",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(annotation);
  });

  test("POST accepts a bounded normalized anchor tied to one content version", async () => {
    const versioned = {
      ...annotation,
      anchor: { contentVersion: "a".repeat(64), v: 2, x: 0.25, y: 0.75 },
    };
    mocks.addAnnotation.mockResolvedValueOnce(versioned);
    const response = await POST(jsonRequest({
      anchor: versioned.anchor,
      body: "note",
      color: "#e0c060",
      itemId,
      type: "note",
    }));

    expect(response.status).toBe(201);
    expect(mocks.addAnnotation).toHaveBeenCalledWith(
      owner,
      itemId,
      "note",
      versioned.anchor,
      "#e0c060",
      "note",
    );
  });

  test("POST maps a database operation failure to a generic 503", async () => {
    mocks.addAnnotation.mockRejectedValueOnce(databaseError("DB_OPERATION_FAILED"));
    const response = await POST(
      jsonRequest({ anchor: { x: 1, y: 2 }, itemId, type: "note" }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database detail");
  });

  test.each([
    { code: "DB_NOT_FOUND", status: 404 },
    { code: "DB_OPERATION_FAILED", status: 503 },
    { code: "DB_INTEGRITY_FAILED", status: 500 },
  ])("DELETE maps $code to $status", async ({ code, status }) => {
    mocks.deleteAnnotation.mockRejectedValueOnce(databaseError(code));
    const response = await DELETE(
      deleteRequest(),
    );

    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private database detail");
  });

  test("DELETE reports success only after an exact delete acknowledgement", async () => {
    const response = await DELETE(
      deleteRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("annotation API request boundary", () => {
  test.each([
    ["missing", undefined],
    ["null", "null"],
    ["cross-origin", "https://attacker.example"],
  ])("rejects %s Origin before POST body parsing", async (_name, origin) => {
    let pulls = 0;
    const encoded = new TextEncoder().encode(
      JSON.stringify({ anchor: { x: 1, y: 2 }, itemId, type: "note" }),
    );
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoded.slice());
        controller.close();
      },
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (origin !== undefined) headers.Origin = origin;
    const request = new Request("http://localhost/api/annotations", {
      body,
      duplex: "half",
      headers,
      method: "POST",
    } as RequestInit & { duplex: "half" });
    const response = await POST(request);

    await expectAPIError(response, 403, "CROSS_ORIGIN_REQUEST");
    expect(pulls).toBe(0);
    expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
    expect(mocks.addAnnotation).not.toHaveBeenCalled();
  });

  test.each([401, 403, 503])(
    "rejects auth status %i before pulling a hostile body",
    async (status) => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      });
      mocks.authorizeAPI.mockResolvedValueOnce({
        ok: false,
        response: new Response("denied", { status }),
      });

      const response = await POST(
        new Request("http://localhost/api/annotations", {
          body,
          duplex: "half",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          method: "POST",
        } as RequestInit & { duplex: "half" }),
      );

      expect(response.status).toBe(status);
      expect(pulls).toBe(0);
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.addAnnotation).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, "null", "https://attacker.example"])(
    "rejects unsafe DELETE Origin %s before mutation",
    async (origin) => {
      const headers: Record<string, string> = {};
      if (origin !== undefined) headers.Origin = origin;
      const response = await DELETE(
        new Request(`http://localhost/api/annotations?id=${annotationId}`, {
          headers,
          method: "DELETE",
        }),
      );

      await expectAPIError(response, 403, "CROSS_ORIGIN_REQUEST");
      expect(mocks.consumeAPIRateLimit).not.toHaveBeenCalled();
      expect(mocks.deleteAnnotation).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["rate limited", "limited", 429, "RATE_LIMITED", "23"],
    ["quota unavailable", "unavailable", 503, "SERVICE_UNAVAILABLE", null],
  ] as const)(
    "fails closed on %s before pulling a hostile POST body",
    async (_name, quotaOutcome, status, code, retryAfter) => {
      if (quotaOutcome === "limited") {
        mocks.consumeAPIRateLimit.mockResolvedValueOnce({
          allowed: false,
          retryAfter: 23,
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
      const request = new Request("http://localhost/api/annotations", {
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
      expect(mocks.addAnnotation).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["rate limited", "limited", 429, "RATE_LIMITED", "41"],
    ["quota unavailable", "unavailable", 503, "SERVICE_UNAVAILABLE", null],
  ] as const)(
    "returns %s before parsing a hostile DELETE query or calling the DAL",
    async (_name, quotaOutcome, status, code, retryAfter) => {
      if (quotaOutcome === "limited") {
        mocks.consumeAPIRateLimit.mockResolvedValueOnce({
          allowed: false,
          retryAfter: 41,
        });
      } else {
        mocks.consumeAPIRateLimit.mockRejectedValueOnce(
          new Error("private quota backend detail"),
        );
      }
      const request = new Request(
        "http://localhost/api/annotations?id=not-a-canonical-uuid&extra=hostile",
        {
          headers: { Origin: "http://localhost" },
          method: "DELETE",
        },
      );

      const response = await DELETE(request);

      await expectAPIError(response, status, code);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(
        request,
        "owner_write",
        owner,
      );
      expect(mocks.deleteAnnotation).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["missing content type", {}],
    ["wrong content type", { "Content-Type": "text/plain" }],
    ["compressed body", { "Content-Encoding": "gzip", "Content-Type": "application/json" }],
  ])("rejects %s without parsing", async (_name, extraHeaders) => {
    const request = new Request("http://localhost/api/annotations", {
      body: JSON.stringify({ anchor: { x: 1, y: 2 }, itemId, type: "note" }),
      headers: { Origin: "http://localhost", ...extraHeaders },
      method: "POST",
    });
    const response = await POST(request);

    await expectAPIError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
    expect(mocks.addAnnotation).not.toHaveBeenCalled();
  });

  test("stops an undeclared streaming body above 32 KiB", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(9_000).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent === 100) controller.close();
      },
    });
    const response = await POST(
      new Request("http://localhost/api/annotations", {
        body,
        duplex: "half",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        method: "POST",
      } as RequestInit & { duplex: "half" }),
    );

    await expectAPIError(response, 413, "PAYLOAD_TOO_LARGE");
    expect(sent).toBeLessThan(100);
    expect(cancelled).toBe(true);
    expect(mocks.addAnnotation).not.toHaveBeenCalled();
  });

  test.each([
    ["non-canonical item UUID", { anchor: { x: 1, y: 2 }, itemId: "not-a-uuid", type: "note" }],
    ["unknown top-level field", { anchor: { x: 1, y: 2 }, extra: true, itemId, type: "note" }],
    ["unknown anchor field", { anchor: { extra: true, x: 1, y: 2 }, itemId, type: "note" }],
    ["invalid coordinate", { anchor: { x: 1_000_001, y: 2 }, itemId, type: "note" }],
    ["too few pen points", { anchor: { points: [[1, 2]] }, itemId, type: "pen" }],
    [
      "anchor beyond its encoded byte bound",
      {
        anchor: { points: Array.from({ length: 2_048 }, () => [1_000, 1_000]) },
        itemId,
        type: "pen",
      },
    ],
    [
      "too many highlight rectangles",
      {
        anchor: { rects: Array.from({ length: 257 }, () => ({ h: 1, w: 1, x: 1, y: 1 })) },
        itemId,
        type: "highlight",
      },
    ],
    ["overlong note", { anchor: { x: 1, y: 2 }, body: "字".repeat(1001), itemId, type: "note" }],
  ])("rejects %s rather than coercing or truncating", async (_name, payload) => {
    const response = await POST(jsonRequest(payload));

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.addAnnotation).not.toHaveBeenCalled();
  });

  test.each([
    ["GET invalid UUID", "itemId=not-a-uuid", GET, mocks.getAnnotations],
    ["GET duplicate query", `itemId=${itemId}&itemId=${itemId}`, GET, mocks.getAnnotations],
    ["GET unknown query", `itemId=${itemId}&extra=1`, GET, mocks.getAnnotations],
    ["DELETE invalid UUID", "id=not-a-uuid", DELETE, mocks.deleteAnnotation],
    ["DELETE duplicate query", `id=${annotationId}&id=${annotationId}`, DELETE, mocks.deleteAnnotation],
    ["DELETE unknown query", `id=${annotationId}&extra=1`, DELETE, mocks.deleteAnnotation],
  ])("rejects %s before the DAL", async (_name, query, handler, downstream) => {
    const response = await handler(
      new Request(`http://localhost/api/annotations?${query}`, {
        headers: { Origin: "http://localhost" },
        method: handler === DELETE ? "DELETE" : "GET",
      }),
    );

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(downstream).not.toHaveBeenCalled();
  });

  test("successful responses are private and nosniff", async () => {
    const response = await POST(
      jsonRequest({ anchor: { x: 1, y: 2 }, itemId, type: "note" }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
