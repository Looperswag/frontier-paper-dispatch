import { beforeEach, describe, expect, test, vi } from "vitest";
import { withRuntimeEnvironment } from "./runtime-env.ts";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase.ts", () => ({ getClient: vi.fn(async () => ({ rpc: mocks.rpc })) }));

import {
  claimDeliveries,
  claimDigestDeliveries,
  enqueueDigestDeliveries,
  finishDelivery,
  requeueFailedDigestDeliveries,
  retryAt,
} from "./outbox.ts";

const base = {
  SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
  SUPABASE_URL: "https://frontier.example.com",
};

beforeEach(() => {
  mocks.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === "claim_delivery" || name === "claim_digest_delivery") {
      return { data: [], error: null };
    }
    if (name === "requeue_failed_deliveries") return { data: [], error: null };
    return { data: [{ delivery_id: "00000000-0000-4000-8000-000000000001", delivery_status: "pending", inserted: true }], error: null };
  });
});

describe("delivery outbox client", () => {
  test("enqueues only configured providers", async () => {
    await withRuntimeEnvironment(base, () => enqueueDigestDeliveries("Digest 2026-07-14", "# digest"));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_delivery", expect.objectContaining({
      p_channel: "wechat",
      p_provider_id: "serverchan",
      p_digest_date: "2026-07-14",
    }));
  });

  test("binds pipeline delivery enqueue to the active run owner", async () => {
    const runId = "00000000-0000-4000-8000-000000000009";
    await withRuntimeEnvironment(base, () =>
      enqueueDigestDeliveries("Digest 2026-07-14", "# digest", base, runId),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("enqueue_pipeline_delivery", expect.objectContaining({
      p_digest_date: "2026-07-14",
      p_run_id: runId,
    }));
  });

  test("enqueues SMTP and ServerChan with the same bounded payload", async () => {
    const env = {
      ...base,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "mailer@example.com",
      SMTP_PASS: "secret",
      EMAIL_FROM: "mailer@example.com",
      EMAIL_TO: "hgjly1206@163.com",
    };
    await withRuntimeEnvironment(env, () => enqueueDigestDeliveries("Digest 2026-07-14", "# digest"));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls.map(([, payload]) => payload.p_channel).sort()).toEqual(["email", "wechat"]);
  });

  test("maps claims and validates worker identity", async () => {
    mocks.rpc.mockImplementationOnce(async () => ({
      data: [{
        delivery_id: "00000000-0000-4000-8000-000000000001",
        digest_date: "2026-07-14",
        channel: "email",
        provider_id: "smtp",
        idempotency_key: "digest:2026-07-14:email",
        payload: { title: "Digest", markdown: "# digest" },
        attempts: 2,
        lease_until: "2026-07-14T00:05:00Z",
      }],
      error: null,
    }));
    await expect(claimDeliveries("00000000-0000-4000-8000-000000000002")).resolves.toMatchObject([
      { channel: "email", attempts: 2, payload: { title: "Digest" } },
    ]);
    await expect(claimDeliveries("not-a-uuid")).rejects.toThrow(/worker id/i);
  });

  test("requeues and claims only the requested digest and configured channels", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [{
          attempts: 2,
          channel: "wechat",
          delivery_id: "00000000-0000-4000-8000-000000000001",
          delivery_status: "pending",
          requeue_count: 1,
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    const workerId = "00000000-0000-4000-8000-000000000002";

    await expect(requeueFailedDigestDeliveries("2026-07-14", base)).resolves.toBe(1);
    await expect(claimDigestDeliveries("2026-07-14", workerId)).resolves.toEqual([]);

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "requeue_failed_deliveries", {
      p_channels: ["wechat"],
      p_digest_date: "2026-07-14",
      p_now: expect.any(String),
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "claim_digest_delivery", {
      p_digest_date: "2026-07-14",
      p_limit: 10,
      p_lease_seconds: 300,
      p_now: expect.any(String),
      p_worker_id: workerId,
    });
  });

  test("finishes a leased delivery and bounds retry delay", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ delivery_id: "00000000-0000-4000-8000-000000000001", delivery_status: "pending", attempts: 1 }],
      error: null,
    });
    await expect(finishDelivery(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "retry",
      { error: "temporary", nextAttemptAt: new Date("2026-07-14T00:01:00Z") },
    )).resolves.toBe("pending");
    expect(retryAt(100, 0).getTime()).toBe(6 * 60 * 60_000);
  });
});
