import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRuntimeEnvironment } from "./runtime-env.ts";
import {
  reserveRootLLMBudget,
  settleRootLLMBudget,
  type RootLLMBudgetReservation,
} from "./llm-budget.ts";

const serviceRoleKey = `sb_secret_${"s".repeat(40)}`;
const requestId = "10000000-0000-4000-8000-000000000001";
const reservationId = "20000000-0000-4000-8000-000000000001";
const fetchMock = vi.fn<typeof fetch>();

const environment = () => ({
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
});

function jsonRPC(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
  });
}

function reservation(): RootLLMBudgetReservation {
  return Object.freeze({
    budgetDate: "2026-07-14",
    reservationId,
    reservedTokens: 5_000,
    subject: "system:ingest" as const,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("root hard LLM budget client", () => {
  test.each([
    ["root_rank", "system:ingest"],
    ["root_summary", "system:ingest"],
    ["root_refine", "system:refine"],
  ] as const)("maps %s to its sealed system subject", async (policy, subject) => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([
        {
          budget_date: "2026-07-14",
          outcome: "reserved",
          reservation_id: reservationId,
          reserved_tokens: 5_000,
          retry_after_seconds: null,
        },
      ]),
    );

    const result = await withRuntimeEnvironment(environment(), () =>
      reserveRootLLMBudget(policy, requestId, 5_000),
    );

    expect(result).toEqual({
      allowed: true,
      budgetDate: "2026-07-14",
      reservationId,
      reservedTokens: 5_000,
      subject,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://frontier-paper.supabase.co/rest/v1/rpc/reserve_llm_budget",
    );
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe(serviceRoleKey);
    expect(headers.get("authorization")).toBe(`Bearer ${serviceRoleKey}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_policy: policy,
      p_request_id: requestId,
      p_reserved_tokens: 5_000,
      p_subject: subject,
    });
  });

  test("returns the bounded database delay when the daily budget is exhausted", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([
        {
          budget_date: "2026-07-14",
          outcome: "budget_exhausted",
          reservation_id: null,
          reserved_tokens: null,
          retry_after_seconds: 3_600,
        },
      ]),
    );

    await expect(
      withRuntimeEnvironment(environment(), () =>
        reserveRootLLMBudget("root_rank", requestId, 5_000),
      ),
    ).resolves.toEqual({ allowed: false, retryAfter: 3_600 });
  });

  test("settles known usage against the reservation's sealed subject", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([{ budget_date: "2026-07-14", charged_tokens: 1_234, outcome: "settled" }]),
    );

    await expect(
      withRuntimeEnvironment(environment(), () =>
        settleRootLLMBudget(reservation(), 1_234),
      ),
    ).resolves.toEqual({ chargedTokens: 1_234 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      p_actual_tokens: 1_234,
      p_reservation_id: reservationId,
      p_subject: "system:ingest",
    });
  });

  test("charges the full reservation when provider usage is unknown", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC([{ budget_date: "2026-07-14", charged_tokens: 5_000, outcome: "settled" }]),
    );

    await expect(
      withRuntimeEnvironment(environment(), () => settleRootLLMBudget(reservation(), null)),
    ).resolves.toEqual({ chargedTokens: 5_000 });
  });

  test.each([
    ["wrong row count", []],
    ["unknown outcome", [{ budget_date: "2026-07-14", outcome: "maybe", reservation_id: null, reserved_tokens: null, retry_after_seconds: null }]],
    ["mismatched amount", [{ budget_date: "2026-07-14", outcome: "reserved", reservation_id: reservationId, reserved_tokens: 4_999, retry_after_seconds: null }]],
    ["extra field", [{ budget_date: "2026-07-14", outcome: "reserved", reservation_id: reservationId, reserved_tokens: 5_000, retry_after_seconds: null, private: true }]],
  ])("fails closed for a malformed reservation response: %s", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(jsonRPC(body));

    await expect(
      withRuntimeEnvironment(environment(), () =>
        reserveRootLLMBudget("root_rank", requestId, 5_000),
      ),
    ).rejects.toThrow("LLM_BUDGET_UNAVAILABLE");
  });

  test("maps provider details to one safe error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRPC({ private: "database detail https://secret.example" }, { status: 500 }),
    );

    let error: unknown;
    try {
      await withRuntimeEnvironment(environment(), () =>
        reserveRootLLMBudget("root_rank", requestId, 5_000),
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe("Error: LLM_BUDGET_UNAVAILABLE");
    expect(String(error)).not.toMatch(/private|database|secret\.example/i);
  });

  test("aborts a hanging RPC at a fixed deadline without retrying", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("private abort")));
      });
    });

    const pending = withRuntimeEnvironment(environment(), () =>
      reserveRootLLMBudget("root_rank", requestId, 5_000),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).rejects.toThrow("LLM_BUDGET_UNAVAILABLE");
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("deadline also cancels a response body that hangs after headers", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
          pull() {
            return new Promise<void>(() => {});
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    const pending = withRuntimeEnvironment(environment(), () =>
      reserveRootLLMBudget("root_rank", requestId, 5_000),
    );
    const observed = Promise.race([
      pending.then(
        () => "resolved",
        (error: unknown) => String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 6_000)),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(observed).resolves.toBe("Error: LLM_BUDGET_UNAVAILABLE");
    expect(cancelled).toBe(true);
  });

  test.each([
    ["bad policy", "web_chat", requestId, 5_000],
    ["non-v4 request", "root_rank", "00000000-0000-1000-8000-000000000001", 5_000],
    ["zero tokens", "root_rank", requestId, 0],
    ["too many tokens", "root_rank", requestId, 65_537],
  ])("rejects %s before network I/O", async (_name, policy, id, tokens) => {
    await expect(
      withRuntimeEnvironment(environment(), () =>
        reserveRootLLMBudget(policy as "root_rank", id, tokens),
      ),
    ).rejects.toThrow("LLM_BUDGET_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
