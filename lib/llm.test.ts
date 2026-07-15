import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { withRuntimeEnvironment } from "./runtime-env.ts";

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  create: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    readonly chat = { completions: { create: mocks.create } };

    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
}));

vi.mock("./llm-budget.ts", () => ({
  reserveRootLLMBudget: mocks.reserve,
  settleRootLLMBudget: mocks.settle,
}));

import { complete, completeJSON, LLMOperationError, MODELS } from "./llm.ts";

const reservation = Object.freeze({
  allowed: true as const,
  budgetDate: "2026-07-14",
  reservationId: "20000000-0000-4000-8000-000000000001",
  reservedTokens: 8_000,
  subject: "system:ingest" as const,
});

function run<T>(operation: () => Promise<T>): Promise<T> {
  return withRuntimeEnvironment(
    { DEEPSEEK_API_KEY: `sk-${crypto.randomUUID().replaceAll("-", "")}` },
    operation,
  );
}

function response(content: string, totalTokens: number | null = 321) {
  return {
    choices: [{ message: { content } }],
    ...(totalTokens === null ? {} : { usage: { total_tokens: totalTokens } }),
  };
}

beforeEach(() => {
  mocks.clientOptions.length = 0;
  mocks.create.mockReset().mockResolvedValue(response("answer"));
  mocks.reserve.mockReset().mockResolvedValue(reservation);
  mocks.settle.mockReset().mockResolvedValue({ chargedTokens: 321 });
});

describe("budgeted root LLM dispatch", () => {
  test("rejects structured output that parses but fails its semantic schema", async () => {
    mocks.create
      .mockResolvedValueOnce(response('{"ok":"yes"}', 100))
      .mockResolvedValueOnce(response('{"ok":2}', 101))
      .mockResolvedValueOnce(response('{"ok":1}', 102));
    mocks.reserve
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000001" })
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000002" })
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000003" });

    await expect(
      run(() =>
        completeJSON({
          model: MODELS.rank,
          policy: "root_rank",
          system: "return json",
          user: "user",
          schema: z.object({ ok: z.boolean() }),
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_PROVIDER_INVALID" });
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.settle).toHaveBeenCalledTimes(3);
  });

  test("reserves before one no-hidden-retry provider attempt and settles before returning", async () => {
    const events: string[] = [];
    mocks.reserve.mockImplementationOnce(async () => {
      events.push("reserve");
      return reservation;
    });
    mocks.create.mockImplementationOnce(async () => {
      events.push("provider");
      return response("answer", 321);
    });
    mocks.settle.mockImplementationOnce(async () => {
      events.push("settle");
      return { chargedTokens: 321 };
    });

    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
          maxTokens: 2_000,
        }),
      ),
    ).resolves.toBe("answer");

    expect(events).toEqual(["reserve", "provider", "settle"]);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    const [policy, requestId, reservedTokens] = mocks.reserve.mock.calls[0];
    expect(policy).toBe("root_rank");
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(reservedTokens).toEqual(expect.any(Number));
    expect(reservedTokens).toBeGreaterThanOrEqual(2_000 + Buffer.byteLength("systemuser"));
    expect(reservedTokens).toBeLessThanOrEqual(65_536);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: reservation.reservationId }),
      321,
    );
    expect(mocks.clientOptions[0]).toMatchObject({ maxRetries: 0 });
    expect(mocks.clientOptions[0]).toHaveProperty("timeout");
  });

  test("passes a caller abort signal to the provider and does not reserve after abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_PROVIDER_REQUEST_FAILED" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test("does not reach the provider when the database budget is exhausted", async () => {
    mocks.reserve.mockResolvedValueOnce({ allowed: false, retryAfter: 3_600 });

    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_BUDGET_EXHAUSTED", retryAfter: 3_600 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  test("validates provider configuration before consuming a budget reservation", async () => {
    await expect(
      withRuntimeEnvironment({}, () =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      ),
    ).rejects.toThrow("DEEPSEEK_API_KEY");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test("full-charges a failed provider attempt and exposes no provider detail", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("secret upstream https://api.deepseek.com?token=private"),
    );
    mocks.settle.mockResolvedValueOnce({ chargedTokens: reservation.reservedTokens });

    let error: unknown;
    try {
      await run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LLMOperationError);
    expect(String(error)).toBe("LLMOperationError: LLM provider request failed");
    expect(String(error)).not.toMatch(/deepseek|private|secret upstream/i);
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: reservation.reservationId }),
      null,
    );
  });

  test("full-charges unknown usage without silently skipping settlement", async () => {
    mocks.create.mockResolvedValueOnce(response("answer", null));
    mocks.settle.mockResolvedValueOnce({ chargedTokens: reservation.reservedTokens });

    await expect(
      run(() =>
        complete({
          model: MODELS.summarize,
          policy: "root_summary",
          system: "system",
          user: "user",
        }),
      ),
    ).resolves.toBe("answer");
    expect(mocks.settle).toHaveBeenCalledWith(expect.any(Object), null);
  });

  test("full-charges a malformed provider envelope without stranding the reservation", async () => {
    mocks.create.mockResolvedValueOnce({ choices: null });
    mocks.settle.mockResolvedValueOnce({ chargedTokens: reservation.reservedTokens });

    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_PROVIDER_INVALID" });
    expect(mocks.settle).toHaveBeenCalledWith(expect.any(Object), null);
  });

  test("rejects impossible provider usage after full-charge", async () => {
    mocks.create.mockResolvedValueOnce(response("answer", reservation.reservedTokens + 1));
    mocks.settle.mockResolvedValueOnce({ chargedTokens: reservation.reservedTokens });

    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_PROVIDER_INVALID" });
    expect(mocks.settle).toHaveBeenCalledWith(expect.any(Object), null);
  });

  test("does not use a provider result when budget settlement fails", async () => {
    mocks.settle.mockRejectedValueOnce(new Error("private database detail"));

    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "user",
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_BUDGET_UNAVAILABLE" });
  });

  test("rejects an oversized dispatch before reserving or calling the provider", async () => {
    await expect(
      run(() =>
        complete({
          model: MODELS.rank,
          policy: "root_rank",
          system: "system",
          user: "x".repeat(70_000),
        }),
      ),
    ).rejects.toMatchObject({ code: "LLM_INPUT_TOO_LARGE" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test("budgets and settles every explicit invalid-JSON retry", async () => {
    mocks.create
      .mockResolvedValueOnce(response("not json", 100))
      .mockResolvedValueOnce(response("still not json", 101))
      .mockResolvedValueOnce(response('{"ok":true}', 102));
    mocks.reserve
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000001" })
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000002" })
      .mockResolvedValueOnce({ ...reservation, reservationId: "20000000-0000-4000-8000-000000000003" });
    mocks.settle
      .mockResolvedValueOnce({ chargedTokens: 100 })
      .mockResolvedValueOnce({ chargedTokens: 101 })
      .mockResolvedValueOnce({ chargedTokens: 102 });

    await expect(
      run(() =>
        completeJSON<{ ok: boolean }>({
          model: MODELS.rank,
          policy: "root_rank",
          system: "return json",
          user: "user",
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(mocks.reserve).toHaveBeenCalledTimes(3);
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.settle).toHaveBeenCalledTimes(3);
    expect(mocks.settle.mock.calls.map((call) => call[1])).toEqual([100, 101, 102]);
  });
});
