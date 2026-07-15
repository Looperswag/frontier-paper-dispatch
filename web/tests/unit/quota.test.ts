import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OwnerContext } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  clientIPFingerprint: vi.fn(),
  getQuotaConfig: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config.server", () => ({ getQuotaConfig: mocks.getQuotaConfig }));
vi.mock("@/lib/request-identity", () => ({
  clientIPFingerprint: mocks.clientIPFingerprint,
}));

import {
  consumeAPIRateLimit,
  reserveLLMBudget,
  settleLLMBudget,
} from "@/lib/quota";

const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const ipFingerprint = `v1:${"a".repeat(64)}`;
const owner = Object.freeze({
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
}) as OwnerContext;
const requestId = "10000000-0000-4000-8000-000000000001";
const reservationId = "20000000-0000-4000-8000-000000000001";
const fetchMock = vi.fn<typeof fetch>();

function request(signal?: AbortSignal): Request {
  return new Request("http://localhost/api/chat", { signal });
}

function jsonRPC(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
  });
}

function allowedRateResponse(): Response {
  return jsonRPC([{ outcome: "allowed", reset_at: null, retry_after_seconds: null }]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(allowedRateResponse());
  mocks.clientIPFingerprint.mockReset().mockReturnValue(ipFingerprint);
  mocks.getQuotaConfig.mockReset().mockReturnValue({
    secret: "r".repeat(40),
    secretVersion: 1,
    serviceRoleKey,
    url: "https://frontier-paper.supabase.co",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("distributed API rate limit client", () => {
  test("posts only verified owner and fingerprint subjects to the sealed RPC", async () => {
    await expect(consumeAPIRateLimit(request(), "web_chat", owner)).resolves.toEqual({
      allowed: true,
    });

    expect(mocks.clientIPFingerprint).toHaveBeenCalledWith(
      expect.any(Request),
      { secret: "r".repeat(40), secretVersion: 1 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://frontier-paper.supabase.co/rest/v1/rpc/consume_api_rate_limits",
    );
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
      redirect: "error",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(serviceRoleKey);
    expect(headers.get("authorization")).toBe(`Bearer ${serviceRoleKey}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_ip_fingerprint: ipFingerprint,
      p_policy: "web_chat",
      p_user_id: owner.userId,
    });
    expect(String(init?.body)).not.toContain(owner.email);
  });

  test("uses only an IP subject for public login", async () => {
    await consumeAPIRateLimit(request(), "auth_login");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      p_ip_fingerprint: ipFingerprint,
      p_policy: "auth_login",
      p_user_id: null,
    });
  });

  test("returns a bounded database Retry-After without exposing counters", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([
        {
          outcome: "rate_limited",
          reset_at: "2026-07-14T00:00:30.000Z",
          retry_after_seconds: 30,
        },
      ]),
    );

    await expect(consumeAPIRateLimit(request(), "web_chat", owner)).resolves.toEqual({
      allowed: false,
      retryAfter: 30,
    });
  });

  test.each([
    ["wrong row count", []],
    ["extra row", [{ outcome: "allowed", reset_at: null, retry_after_seconds: null }, { outcome: "allowed", reset_at: null, retry_after_seconds: null }]],
    ["unknown outcome", [{ outcome: "maybe", reset_at: null, retry_after_seconds: null }]],
    ["allowed with retry", [{ outcome: "allowed", reset_at: null, retry_after_seconds: 1 }]],
    ["denied without reset", [{ outcome: "rate_limited", reset_at: null, retry_after_seconds: 1 }]],
    ["fractional retry", [{ outcome: "rate_limited", reset_at: "2026-07-14T00:00:30Z", retry_after_seconds: 1.5 }]],
    ["unknown field", [{ extra: true, outcome: "allowed", reset_at: null, retry_after_seconds: null }]],
  ])("fails closed for a malformed rate response: %s", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(jsonRPC(body));

    await expect(consumeAPIRateLimit(request(), "web_chat", owner)).rejects.toThrow(
      "QUOTA_UNAVAILABLE",
    );
  });

  test.each([
    ["non-JSON", new Response("ok", { headers: { "Content-Type": "text/plain" } })],
    ["provider error", jsonRPC({ private: "database detail" }, { status: 500 })],
    ["bad JSON", new Response("{", { headers: { "Content-Type": "application/json" } })],
  ])("maps %s to one safe unavailable error", async (_name, response) => {
    fetchMock.mockResolvedValueOnce(response);

    let error: unknown;
    try {
      await consumeAPIRateLimit(request(), "web_chat", owner);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: QUOTA_UNAVAILABLE");
    expect(String(error)).not.toMatch(/private|database|frontier-paper/i);
  });

  test("aborts a hanging quota RPC at its fixed deadline", async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        transportSignal?.addEventListener("abort", () => reject(new Error("private abort")));
      });
    });

    const pending = consumeAPIRateLimit(request(), "web_chat", owner);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).rejects.toThrow("QUOTA_UNAVAILABLE");
    expect(transportSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancels an oversized RPC body before buffering it", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(2048).fill(97));
        if (pulls > 10) controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );

    await expect(consumeAPIRateLimit(request(), "web_chat", owner)).rejects.toThrow(
      "QUOTA_UNAVAILABLE",
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(11);
  });
});

describe("hard LLM budget client", () => {
  test("reserves a bounded Web dispatch before provider work", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([
        {
          budget_date: "2026-07-14",
          outcome: "reserved",
          reservation_id: reservationId,
          reserved_tokens: 50000,
          retry_after_seconds: null,
        },
      ]),
    );

    await expect(
      reserveLLMBudget(request(), owner, requestId, 50000),
    ).resolves.toEqual({
      allowed: true,
      budgetDate: "2026-07-14",
      reservationId,
      reservedTokens: 50000,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://frontier-paper.supabase.co/rest/v1/rpc/reserve_llm_budget",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      p_policy: "web_chat",
      p_request_id: requestId,
      p_reserved_tokens: 50000,
      p_subject: owner.userId,
    });
  });

  test("maps an exhausted hard budget to its Shanghai-midnight delay", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([
        {
          budget_date: "2026-07-14",
          outcome: "budget_exhausted",
          reservation_id: null,
          reserved_tokens: null,
          retry_after_seconds: 1234,
        },
      ]),
    );

    await expect(
      reserveLLMBudget(request(), owner, requestId, 50000),
    ).resolves.toEqual({ allowed: false, retryAfter: 1234 });
  });

  test.each([
    ["mismatched reservation amount", { budget_date: "2026-07-14", outcome: "reserved", reservation_id: reservationId, reserved_tokens: 49999, retry_after_seconds: null }],
    ["invalid reservation id", { budget_date: "2026-07-14", outcome: "reserved", reservation_id: "bad", reserved_tokens: 50000, retry_after_seconds: null }],
    ["exhausted with id", { budget_date: "2026-07-14", outcome: "budget_exhausted", reservation_id: reservationId, reserved_tokens: null, retry_after_seconds: 1 }],
    ["invalid date", { budget_date: "2026-02-30", outcome: "reserved", reservation_id: reservationId, reserved_tokens: 50000, retry_after_seconds: null }],
  ])("rejects malformed reservation response: %s", async (_name, row) => {
    fetchMock.mockResolvedValueOnce(jsonRPC([row]));

    await expect(reserveLLMBudget(request(), owner, requestId, 50000)).rejects.toThrow(
      "QUOTA_UNAVAILABLE",
    );
  });

  test("settles validated actual usage independently of the browser signal", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([{ budget_date: "2026-07-14", charged_tokens: 1200, outcome: "settled" }]),
    );

    await expect(
      settleLLMBudget(
        owner,
        { budgetDate: "2026-07-14", reservationId, reservedTokens: 50000 },
        1200,
      ),
    ).resolves.toEqual({ chargedTokens: 1200 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://frontier-paper.supabase.co/rest/v1/rpc/settle_llm_budget",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      p_actual_tokens: 1200,
      p_reservation_id: reservationId,
      p_subject: owner.userId,
    });
  });

  test("charges the full reservation when provider usage is unknown", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([{ budget_date: "2026-07-14", charged_tokens: 50000, outcome: "settled" }]),
    );

    await expect(
      settleLLMBudget(
        owner,
        { budgetDate: "2026-07-14", reservationId, reservedTokens: 50000 },
        null,
      ),
    ).resolves.toEqual({ chargedTokens: 50000 });
  });

  test.each([0, -1, 50001, 1.5, Number.NaN])(
    "rejects invalid actual usage %s before the settlement RPC",
    async (actual) => {
      await expect(
        settleLLMBudget(
          owner,
          { budgetDate: "2026-07-14", reservationId, reservedTokens: 50000 },
          actual,
        ),
      ).rejects.toThrow("QUOTA_UNAVAILABLE");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
