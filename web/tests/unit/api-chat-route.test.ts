import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAPI: vi.fn(),
  create: vi.fn(),
  deepseek: vi.fn(),
  getChats: vi.fn(),
  getPaper: vi.fn(),
  consumeAPIRateLimit: vi.fn(),
  reserveLLMBudget: vi.fn(),
  saveChat: vi.fn(),
  settleLLMBudget: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ authorizeAPI: mocks.authorizeAPI }));
vi.mock("@/lib/data", () => ({
  getChats: mocks.getChats,
  getPaper: mocks.getPaper,
  saveChat: mocks.saveChat,
}));
vi.mock("@/lib/llm", () => ({
  CHAT_MODEL: "test-chat-model",
  deepseek: mocks.deepseek,
}));
vi.mock("@/lib/quota", () => ({
  consumeAPIRateLimit: mocks.consumeAPIRateLimit,
  reserveLLMBudget: mocks.reserveLLMBudget,
  settleLLMBudget: mocks.settleLLMBudget,
}));

import { GET, POST } from "@/app/api/chat/route";

const itemId = "00000000-0000-4000-8000-000000000001";
const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};
const reservation = Object.freeze({
  budgetDate: "2026-07-14",
  reservationId: "20000000-0000-4000-8000-000000000001",
  reservedTokens: 50_000,
});

function request(message = "question") {
  return new Request("http://localhost/api/chat", {
    body: JSON.stringify({ itemId, message }),
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    method: "POST",
  });
}

async function expectAPIError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: { code }, ok: false });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

function completion(
  parts: string[],
  failure?: Error,
  finishReason: string | null = "stop",
  totalTokens: number | null = 1_200,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const content of parts) {
        yield { choices: [{ delta: { content }, finish_reason: null }] };
      }
      if (failure) throw failure;
      if (finishReason !== null) {
        yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      }
      if (totalTokens !== null) {
        yield { choices: [], usage: { total_tokens: totalTokens } };
      }
    },
  };
}

beforeEach(() => {
  mocks.authorizeAPI.mockReset().mockResolvedValue({
    ok: true,
    owner,
  });
  mocks.getPaper.mockReset().mockResolvedValue({
    abstract: "abstract",
    authors: ["Author"],
    id: itemId,
    source: "arxiv",
    title: "Paper",
    url: "https://example.com/paper",
  });
  mocks.getChats.mockReset().mockResolvedValue([]);
  mocks.consumeAPIRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.reserveLLMBudget.mockReset().mockResolvedValue({
    allowed: true,
    ...reservation,
  });
  mocks.saveChat.mockReset().mockResolvedValue(undefined);
  mocks.settleLLMBudget.mockReset().mockResolvedValue({ chargedTokens: 1_200 });
  mocks.create.mockReset().mockResolvedValue(completion(["complete answer"]));
  mocks.deepseek.mockReset().mockReturnValue({
    chat: { completions: { create: mocks.create } },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat GET truthful empty state", () => {
  test("returns 400 rather than a manufactured empty history without itemId", async () => {
    const response = await GET(new Request("http://localhost/api/chat"));

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.getChats).not.toHaveBeenCalled();
  });

  test.each([
    ["a database operation failure", "DB_OPERATION_FAILED", 503, "SERVICE_UNAVAILABLE"],
    ["a database integrity failure", "DB_INTEGRITY_FAILED", 500, "INTERNAL_ERROR"],
    ["an unknown database failure", undefined, 500, "INTERNAL_ERROR"],
  ])("maps %s to a fixed error", async (_name, errorCode, status, responseCode) => {
    mocks.getChats.mockRejectedValueOnce(
      Object.assign(
        new Error("private database detail"),
        errorCode === undefined ? {} : { code: errorCode },
      ),
    );
    const response = await GET(
      new Request(`http://localhost/api/chat?itemId=${itemId}`),
    );

    await expectAPIError(response, status, responseCode);
  });

  test("returns a real empty query result as an empty history", async () => {
    const response = await GET(
      new Request(`http://localhost/api/chat?itemId=${itemId}`),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ chats: [] });
  });

  test.each([
    ["invalid UUID", "itemId=not-a-uuid"],
    ["duplicate itemId", `itemId=${itemId}&itemId=${itemId}`],
    ["unknown query", `itemId=${itemId}&extra=1`],
  ])("rejects %s before loading history", async (_name, query) => {
    const response = await GET(new Request(`http://localhost/api/chat?${query}`));

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.getChats).not.toHaveBeenCalled();
  });
});

describe("chat POST request boundary", () => {
  test.each([401, 403, 503])(
    "does not pull the request body when authorization returns %i",
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
        new Request("http://localhost/api/chat", {
          body,
          duplex: "half",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          method: "POST",
        } as RequestInit & { duplex: "half" }),
      );

      expect(response.status).toBe(status);
      expect(pulls).toBe(0);
      expect(mocks.getPaper).not.toHaveBeenCalled();
      expect(mocks.getChats).not.toHaveBeenCalled();
      expect(mocks.saveChat).not.toHaveBeenCalled();
      expect(mocks.deepseek).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, "null", "https://attacker.example"])(
    "rejects unsafe Origin %s before pulling the request body",
    async (origin) => {
      let pulls = 0;
      const encoded = new TextEncoder().encode(JSON.stringify({ itemId, message: "question" }));
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
      const response = await POST(
        new Request("http://localhost/api/chat", {
          body,
          duplex: "half",
          headers,
          method: "POST",
        } as RequestInit & { duplex: "half" }),
      );

      await expectAPIError(response, 403, "CROSS_ORIGIN_REQUEST");
      expect(pulls).toBe(0);
      expect(mocks.getPaper).not.toHaveBeenCalled();
      expect(mocks.deepseek).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["distributed denial", { allowed: false, retryAfter: 37 }, 429, "RATE_LIMITED", "37"],
    ["quota outage", new Error("private quota detail"), 503, "SERVICE_UNAVAILABLE", null],
  ] as const)(
    "stops before pulling a hostile body on %s",
    async (_name, decision, status, code, retryAfter) => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("hostile"));
          controller.close();
        },
      });
      if (decision instanceof Error) {
        mocks.consumeAPIRateLimit.mockRejectedValueOnce(decision);
      } else {
        mocks.consumeAPIRateLimit.mockResolvedValueOnce(decision);
      }

      const req = new Request("http://localhost/api/chat", {
        body,
        duplex: "half",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        method: "POST",
      } as RequestInit & { duplex: "half" });
      const response = await POST(req);

      await expectAPIError(response, status, code);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(mocks.consumeAPIRateLimit).toHaveBeenCalledWith(req, "web_chat", owner);
      expect(pulls).toBe(0);
      expect(mocks.getPaper).not.toHaveBeenCalled();
      expect(mocks.getChats).not.toHaveBeenCalled();
      expect(mocks.reserveLLMBudget).not.toHaveBeenCalled();
      expect(mocks.saveChat).not.toHaveBeenCalled();
      expect(mocks.deepseek).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["missing content type", {}],
    ["wrong content type", { "Content-Type": "text/plain" }],
    ["compressed body", { "Content-Encoding": "gzip", "Content-Type": "application/json" }],
  ])("rejects %s before any paper read", async (_name, extraHeaders) => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        body: JSON.stringify({ itemId, message: "question" }),
        headers: { Origin: "http://localhost", ...extraHeaders },
        method: "POST",
      }),
    );

    await expectAPIError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
    expect(mocks.getPaper).not.toHaveBeenCalled();
  });

  test("rejects a declared body above 8 KiB without downstream work", async () => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        body: "{}",
        headers: {
          "Content-Length": "9000",
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );

    await expectAPIError(response, 413, "PAYLOAD_TOO_LARGE");
    expect(mocks.getPaper).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid UUID", { itemId: "not-a-uuid", message: "question" }],
    ["blank message", { itemId, message: "  \n" }],
    ["overlong message", { itemId, message: "a".repeat(2001) }],
    ["unknown field", { extra: true, itemId, message: "question" }],
    ["non-string message", { itemId, message: 7 }],
  ])("rejects %s instead of coercing input", async (_name, payload) => {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        method: "POST",
      }),
    );

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.getPaper).not.toHaveBeenCalled();
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.deepseek).not.toHaveBeenCalled();
  });

  test("normalizes surrounding whitespace once before persistence and LLM use", async () => {
    const response = await POST(request("  question  "));

    await expect(response.text()).resolves.toBe("complete answer");
    expect(mocks.saveChat).toHaveBeenNthCalledWith(1, owner, itemId, "user", "question");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([{ role: "user", content: "question" }]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("reserves a conservative hard budget before any write or provider dispatch", async () => {
    const req = request();
    const response = await POST(req);

    await expect(response.text()).resolves.toBe("complete answer");
    expect(mocks.reserveLLMBudget).toHaveBeenCalledTimes(1);
    const [budgetRequest, budgetOwner, requestId, reservedTokens] =
      mocks.reserveLLMBudget.mock.calls[0];
    expect(budgetRequest).toBe(req);
    expect(budgetOwner).toBe(owner);
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.isInteger(reservedTokens)).toBe(true);
    expect(reservedTokens).toBeGreaterThan(1_500);
    expect(reservedTokens).toBeLessThanOrEqual(65_536);
    expect(mocks.reserveLLMBudget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveChat.mock.invocationCallOrder[0],
    );
    expect(mocks.reserveLLMBudget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0],
    );
  });

  test("returns the hard-budget delay before writing or dispatching", async () => {
    mocks.reserveLLMBudget.mockResolvedValueOnce({ allowed: false, retryAfter: 1_234 });

    const response = await POST(request());

    await expectAPIError(response, 429, "LLM_BUDGET_EXHAUSTED");
    expect(response.headers.get("Retry-After")).toBe("1234");
    expect(mocks.getPaper).toHaveBeenCalledTimes(1);
    expect(mocks.getChats).toHaveBeenCalledTimes(1);
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.deepseek).not.toHaveBeenCalled();
  });

  test("fails closed before writing when budget reservation is unavailable", async () => {
    mocks.reserveLLMBudget.mockRejectedValueOnce(new Error("private quota detail"));

    const response = await POST(request());

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.deepseek).not.toHaveBeenCalled();
  });

  test("rejects an unreservable database context before writing or dispatching", async () => {
    mocks.getPaper.mockResolvedValueOnce({
      abstract: "a".repeat(70_000),
      authors: [],
      id: itemId,
      source: "arxiv",
      title: "Paper",
      url: "https://example.com/paper",
    });

    const response = await POST(request());

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.reserveLLMBudget).not.toHaveBeenCalled();
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.deepseek).not.toHaveBeenCalled();
  });
});

describe("chat POST truthful streaming", () => {
  test("returns a non-success response and skips the LLM when the user message is not persisted", async () => {
    mocks.saveChat.mockRejectedValueOnce(
      Object.assign(new Error("private database detail"), { code: "DB_OPERATION_FAILED" }),
    );

    const response = await POST(request());

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
  });

  test("returns 502 when the LLM request fails before a stream is established", async () => {
    mocks.create.mockRejectedValueOnce(new Error("private upstream detail"));

    const response = await POST(request());

    await expectAPIError(response, 502, "UPSTREAM_UNAVAILABLE");
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
  });

  test("does not persist a partial assistant answer when the upstream stream fails", async () => {
    mocks.create.mockResolvedValueOnce(completion(["partial"], new Error("stream failed")));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    expect(mocks.saveChat).toHaveBeenCalledWith(owner, itemId, "user", "question");
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
  });

  test("turns a zero-token completion into a stream failure", async () => {
    mocks.create.mockResolvedValueOnce(completion([]));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
  });

  test("requires the final provider usage chunk and charges the reservation when it is missing", async () => {
    mocks.create.mockResolvedValueOnce(completion(["complete answer"], undefined, "stop", null));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test.each([
    { name: "a length-truncated finish", reason: "length" },
    { name: "no finish marker", reason: null },
  ])("rejects $name without persisting the assistant", async ({ reason }) => {
    mocks.create.mockResolvedValueOnce(completion(["apparently complete"], undefined, reason));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("rejects whitespace-only tokens even with an explicit stop", async () => {
    mocks.create.mockResolvedValueOnce(completion(["  \n"]));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("rejects content received after the finish marker", async () => {
    mocks.create.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "first" }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        yield { choices: [{ delta: { content: "late" }, finish_reason: null }] };
      },
    });
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("returns 404 without writing when the paper does not exist", async () => {
    mocks.getPaper.mockResolvedValueOnce(null);
    const response = await POST(request());

    await expectAPIError(response, 404, "NOT_FOUND");
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test("returns 503 when history cannot be loaded", async () => {
    mocks.getChats.mockRejectedValueOnce(
      Object.assign(new Error("private history detail"), { code: "DB_OPERATION_FAILED" }),
    );
    const response = await POST(request());

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  test("persists the assistant only after a complete nonempty stream", async () => {
    mocks.create.mockResolvedValueOnce(completion(["complete ", "answer"]));
    const response = await POST(request());

    await expect(response.text()).resolves.toBe("complete answer");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.deepseek).toHaveBeenCalledWith(owner);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.settleLLMBudget).toHaveBeenCalledTimes(1);
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, 1_200);
    expect(mocks.settleLLMBudget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveChat.mock.invocationCallOrder[1],
    );
    expect(mocks.saveChat).toHaveBeenNthCalledWith(1, owner, itemId, "user", "question");
    expect(mocks.saveChat).toHaveBeenNthCalledWith(
      2,
      owner,
      itemId,
      "assistant",
      "complete answer",
    );
  });

  test("fails the stream when the complete assistant answer cannot be persisted", async () => {
    mocks.saveChat
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("assistant persistence failed"));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.saveChat).toHaveBeenCalledTimes(2);
    expect(mocks.settleLLMBudget).toHaveBeenCalledTimes(1);
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, 1_200);
  });

  test("fails the stream and skips assistant persistence when settlement is unavailable", async () => {
    mocks.settleLLMBudget.mockRejectedValueOnce(new Error("private quota detail"));
    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.settleLLMBudget).toHaveBeenCalledTimes(1);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("aborts an uncooperative provider iterator at the end-to-end deadline", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let returned = false;
    mocks.create.mockImplementationOnce(async (_body, options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<never>>(() => {}),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    });

    const response = await POST(request());
    const body = response.text();
    void body.catch(() => {});
    await vi.advanceTimersByTimeAsync(61_000);

    await expect(body).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(returned).toBe(true);
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("terminates an oversized streamed body before assistant persistence", async () => {
    mocks.create.mockResolvedValueOnce(completion(["x".repeat(256 * 1024 + 1)]));

    const response = await POST(request());

    await expect(response.text()).rejects.toThrow();
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });

  test("cancelling the response aborts and closes the provider iterator", async () => {
    let nextCalls = 0;
    let aborted = false;
    let returned = false;
    mocks.create.mockImplementationOnce(async (_body, options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              nextCalls += 1;
              if (nextCalls === 1) {
                return Promise.resolve({
                  done: false as const,
                  value: { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
                });
              }
              return new Promise<IteratorResult<never>>(() => {});
            },
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(() => expect(returned).toBe(true));
    expect(mocks.settleLLMBudget).toHaveBeenCalledWith(owner, reservation, null);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
  });
});
