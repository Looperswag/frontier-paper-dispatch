import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRuntimeEnvironment } from "../../lib/runtime-env.ts";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  claimDigest: vi.fn(),
  requeue: vi.fn(),
  finish: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("../../lib/email.ts", () => ({
  classifyEmailFailure: () => "retryable",
  sendEmail: mocks.sendEmail,
}));
vi.mock("../../lib/alert.ts", () => ({ sendFailureAlert: mocks.alert }));
vi.mock("../../lib/outbox.ts", () => ({
  claimDigestDeliveries: mocks.claimDigest,
  deliveryDateFromTitle: (title: string) => title.match(/\d{4}-\d{2}-\d{2}/)?.[0],
  enqueueDigestDeliveries: mocks.enqueue,
  claimDeliveries: mocks.claim,
  finishDelivery: mocks.finish,
  requeueFailedDigestDeliveries: mocks.requeue,
  retryAt: () => new Date("2026-07-14T00:00:00Z"),
}));

import {
  processDigestDeliveries,
  processPendingDeliveries,
  pushDigest,
} from "../../scripts/digest.ts";

beforeEach(() => {
  mocks.sendEmail.mockReset().mockResolvedValue(undefined);
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.claim.mockReset().mockResolvedValue([]);
  mocks.claimDigest.mockReset().mockResolvedValue([]);
  mocks.requeue.mockReset().mockResolvedValue(0);
  mocks.finish.mockReset().mockResolvedValue("succeeded");
  mocks.alert.mockReset().mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ code: 0 }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  )));
});

afterEach(() => vi.unstubAllGlobals());

describe("digest delivery", () => {
  test("validates bounded ServerChan responses and invokes optional email delivery", async () => {
    const environment = {
      SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "mailer@example.com",
      SMTP_PASS: "secret",
      EMAIL_FROM: "mailer@example.com",
      EMAIL_TO: "hgjly1206@163.com",
    };
    mocks.sendEmail.mockResolvedValueOnce({ messageId: "<frontier@example.com>" });
    mocks.claimDigest.mockResolvedValueOnce([{
      deliveryId: "00000000-0000-4000-8000-000000000001",
      digestDate: "2026-07-14",
      channel: "email",
      providerId: "smtp",
      idempotencyKey: "digest:2026-07-14:email",
      payload: { title: "前沿论文 · 2026-07-14", markdown: "# digest" },
      attempts: 1,
    }]);
    await withRuntimeEnvironment(environment, () => pushDigest("前沿论文 · 2026-07-14", "# digest"));
    expect(mocks.enqueue).toHaveBeenCalledWith("前沿论文 · 2026-07-14", "# digest");
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: "前沿论文 · 2026-07-14",
      text: "# digest",
      idempotencyKey: "digest:2026-07-14:email",
    }));
    expect(mocks.finish).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      "success",
      expect.any(Object),
    );
  });

  test("never acknowledges a claimed email when the SMTP provider returns no receipt", async () => {
    mocks.claim.mockResolvedValueOnce([{
      deliveryId: "00000000-0000-4000-8000-000000000004",
      digestDate: "2026-07-14",
      channel: "email",
      providerId: "smtp",
      idempotencyKey: "digest:2026-07-14:email",
      payload: { title: "x 2026-07-14", markdown: "y" },
      attempts: 1,
    }]);

    await expect(processPendingDeliveries()).resolves.toMatchObject({
      retried: ["email"],
      succeeded: [],
    });
    expect(mocks.finish).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000004",
      expect.any(String),
      "retry",
      expect.objectContaining({ error: "SMTP delivery failed" }),
    );
  });

  test("rejects an oversized or non-JSON provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "x".repeat(65 * 1024),
      { headers: { "Content-Type": "application/json" }, status: 200 },
    )));
    mocks.claimDigest.mockResolvedValueOnce([{
      deliveryId: "00000000-0000-4000-8000-000000000002",
      digestDate: "2026-07-14",
      channel: "wechat",
      providerId: "serverchan",
      idempotencyKey: "digest:2026-07-14:wechat",
      payload: { title: "x 2026-07-14", markdown: "y" },
      attempts: 1,
    }]);
    await expect(withRuntimeEnvironment({ SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}` }, () => pushDigest("x 2026-07-14", "y"))).rejects.toThrow(/Delivery failed for: wechat/);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({
      event: "delivery_failed",
      severity: "critical",
    }));
  });

  test("rejects a 2xx ServerChan response without an explicit success code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })));
    mocks.claimDigest.mockResolvedValueOnce([{
      deliveryId: "00000000-0000-4000-8000-000000000005",
      digestDate: "2026-07-14",
      channel: "wechat",
      providerId: "serverchan",
      idempotencyKey: "digest:2026-07-14:wechat",
      payload: { title: "x 2026-07-14", markdown: "y" },
      attempts: 1,
    }]);

    await expect(withRuntimeEnvironment(
      { SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}` },
      () => pushDigest("x 2026-07-14", "y"),
    )).rejects.toThrow(/Delivery failed for: wechat/);
    expect(mocks.finish).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000005",
      expect.any(String),
      "permanent",
      expect.objectContaining({ error: "ServerChan delivery failed" }),
    );
  });

  test("keeps a retryable provider failure pending without a premature critical alert", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    mocks.claimDigest.mockResolvedValueOnce([{
      deliveryId: "00000000-0000-4000-8000-000000000003",
      digestDate: "2026-07-14",
      channel: "wechat",
      providerId: "serverchan",
      idempotencyKey: "digest:2026-07-14:wechat",
      payload: { title: "x 2026-07-14", markdown: "y" },
      attempts: 1,
    }]);

    await expect(withRuntimeEnvironment(
      { SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}` },
      () => pushDigest("x 2026-07-14", "y"),
    )).resolves.toMatchObject({ retried: ["wechat"], succeeded: [] });
    expect(mocks.finish).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      expect.any(String),
      "retry",
      expect.objectContaining({ error: "ServerChan delivery failed" }),
    );
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  test("an independent worker safely exits when no delivery is claimable", async () => {
    await expect(processPendingDeliveries()).resolves.toEqual({
      attempted: 0,
      permanentFailures: [],
      retried: [],
      succeeded: [],
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  test("manual replay claims only the requested digest", async () => {
    await expect(processDigestDeliveries("2026-07-14")).resolves.toEqual({
      attempted: 0,
      permanentFailures: [],
      retried: [],
      succeeded: [],
    });

    expect(mocks.claimDigest).toHaveBeenCalledWith(
      "2026-07-14",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
