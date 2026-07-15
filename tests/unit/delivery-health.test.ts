import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";
import {
  checkDeliveryDeadline,
  createDeliveryHealthStore,
  type DeliveryHealthStore,
} from "../../lib/delivery-health.ts";

const workerId = "00000000-0000-4000-8000-000000000123";
const baseEnvironment = {
  ALERT_WEBHOOK_URL: "https://alerts.example.test/frontier",
};

function store(overrides: Partial<DeliveryHealthStore> = {}): DeliveryHealthStore {
  return {
    claimAlert: vi.fn().mockResolvedValue({ attempts: 1, claimed: true, status: "in_flight" }),
    finishAlert: vi.fn().mockResolvedValue("succeeded"),
    getHealth: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("delivery deadline policy", () => {
  test("checks the previous due date before 23:30 instead of losing an overnight wake-up", async () => {
    const database = store({
      getHealth: vi.fn().mockResolvedValue([
        { attempts: 1, channel: "wechat", deliveredAt: "2026-07-14T14:02:00.000Z", status: "succeeded" },
      ]),
    });
    const sendAlert = vi.fn();

    await expect(checkDeliveryDeadline({
      environment: baseEnvironment,
      now: new Date("2026-07-15T15:29:59.999Z"),
      sendAlert,
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-14", missing: [], status: "healthy" });

    expect(database.getHealth).toHaveBeenCalledWith("2026-07-14");
    expect(database.claimAlert).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test("treats 23:30 exactly as due and requires WeChat by default", async () => {
    const database = store({
      getHealth: vi.fn().mockResolvedValue([
        { attempts: 1, channel: "wechat", deliveredAt: "2026-07-15T14:02:00.000Z", status: "succeeded" },
      ]),
    });

    await expect(checkDeliveryDeadline({
      environment: baseEnvironment,
      now: new Date("2026-07-15T15:30:00.000Z"),
      sendAlert: vi.fn(),
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-15", missing: [], status: "healthy" });

    expect(database.getHealth).toHaveBeenCalledWith("2026-07-15");
    expect(database.claimAlert).not.toHaveBeenCalled();
  });

  test("requires email as well when SMTP delivery is configured", async () => {
    const database = store({
      getHealth: vi.fn().mockResolvedValue([
        { attempts: 1, channel: "wechat", deliveredAt: "2026-07-15T14:02:00.000Z", status: "succeeded" },
      ]),
    });
    const sendAlert = vi.fn().mockResolvedValue(true);
    const environment = {
      ...baseEnvironment,
      EMAIL_FROM: "sender@example.test",
      EMAIL_TO: "reader@example.test",
      SMTP_HOST: "smtp.example.test",
      SMTP_PASS: "secret",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "sender@example.test",
    };

    await expect(checkDeliveryDeadline({
      environment,
      now: new Date("2026-07-15T16:00:00.000Z"),
      sendAlert,
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-15", missing: ["email"], status: "alerted" });

    expect(database.getHealth).toHaveBeenCalledWith("2026-07-15");

    await expect(checkDeliveryDeadline({
      environment,
      now: new Date("2026-07-16T15:30:00.000Z"),
      sendAlert,
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-16", missing: ["email"], status: "alerted" });

    expect(database.claimAlert).toHaveBeenCalledWith({
      alertKey: "deadline:email",
      date: "2026-07-16",
      leaseSeconds: 300,
      now: "2026-07-16T15:30:00.000Z",
      workerId,
    });
    expect(sendAlert).toHaveBeenCalledWith(
      {
        correlationId: "delivery-deadline:2026-07-16:email",
        detail: "missing_channels=email; deadline=23:30 Asia/Shanghai",
        event: "delivery_deadline_missed",
        runDate: "2026-07-16",
        severity: "critical",
      },
      environment,
    );
    expect(database.finishAlert).toHaveBeenCalledWith({
      alertKey: "deadline:email",
      date: "2026-07-16",
      error: null,
      outcome: "success",
      workerId,
    });
  });

  test("releases the claim for a later retry when the independent webhook fails", async () => {
    const database = store();

    await expect(checkDeliveryDeadline({
      environment: baseEnvironment,
      now: new Date("2026-07-15T15:45:00.000Z"),
      sendAlert: vi.fn().mockResolvedValue(false),
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-15", missing: ["wechat"], status: "retry" });

    expect(database.finishAlert).toHaveBeenCalledWith({
      alertKey: "deadline:wechat",
      date: "2026-07-15",
      error: "Alert webhook delivery failed",
      outcome: "retry",
      workerId,
    });
  });

  test("does not send or finish when another worker owns or completed the alert", async () => {
    const database = store({
      claimAlert: vi.fn().mockResolvedValue({ attempts: 2, claimed: false, status: "in_flight" }),
    });
    const sendAlert = vi.fn();

    await expect(checkDeliveryDeadline({
      environment: baseEnvironment,
      now: new Date("2026-07-15T15:45:00.000Z"),
      sendAlert,
      store: database,
      workerId,
    })).resolves.toEqual({ date: "2026-07-15", missing: ["wechat"], status: "already_claimed" });

    expect(sendAlert).not.toHaveBeenCalled();
    expect(database.finishAlert).not.toHaveBeenCalled();
  });

  test("treats an exception from the alert sender as retryable", async () => {
    const database = store();

    await expect(checkDeliveryDeadline({
      environment: baseEnvironment,
      now: new Date("2026-07-15T15:45:00.000Z"),
      sendAlert: vi.fn().mockRejectedValue(new Error("secret provider detail")),
      store: database,
      workerId,
    })).resolves.toMatchObject({ status: "retry" });

    expect(database.finishAlert).toHaveBeenCalledWith(expect.objectContaining({
      error: "Alert webhook delivery failed",
      outcome: "retry",
    }));
  });
});

describe("delivery health Supabase adapter", () => {
  test("uses the service-role RPC contract and validates acknowledged rows", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{ attempts: 2, channel: "wechat", delivered_at: null, status: "pending" }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ alert_status: "in_flight", attempts: 1, claimed: true }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ alert_status: "pending" }], error: null });
    const database = createDeliveryHealthStore(async () => ({ rpc }) as unknown as SupabaseClient);

    await expect(database.getHealth("2026-07-15")).resolves.toEqual([
      { attempts: 2, channel: "wechat", deliveredAt: null, status: "pending" },
    ]);
    await expect(database.claimAlert({
      alertKey: "deadline:wechat",
      date: "2026-07-15",
      leaseSeconds: 300,
      now: "2026-07-15T15:45:00.000Z",
      workerId,
    })).resolves.toEqual({ attempts: 1, claimed: true, status: "in_flight" });
    await expect(database.finishAlert({
      alertKey: "deadline:wechat",
      date: "2026-07-15",
      error: "Alert webhook delivery failed",
      outcome: "retry",
      workerId,
    })).resolves.toBe("pending");

    expect(rpc).toHaveBeenNthCalledWith(1, "get_delivery_health", { p_digest_date: "2026-07-15" });
    expect(rpc).toHaveBeenNthCalledWith(2, "claim_delivery_alert", {
      p_alert_date: "2026-07-15",
      p_alert_key: "deadline:wechat",
      p_lease_seconds: 300,
      p_now: "2026-07-15T15:45:00.000Z",
      p_worker_id: workerId,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "finish_delivery_alert", {
      p_alert_date: "2026-07-15",
      p_alert_key: "deadline:wechat",
      p_error: "Alert webhook delivery failed",
      p_outcome: "retry",
      p_worker_id: workerId,
    });
  });

  test("fails closed on malformed RPC data", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ attempts: 1, channel: "sms", delivered_at: null, status: "succeeded" }],
      error: null,
    });
    const database = createDeliveryHealthStore(async () => ({ rpc }) as unknown as SupabaseClient);

    await expect(database.getHealth("2026-07-15")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "delivery.health",
    });
  });

  test("rejects impossible claim and completion acknowledgements", async () => {
    const impossibleClaim = createDeliveryHealthStore(async () => ({
      rpc: vi.fn().mockResolvedValue({
        data: [{ alert_status: "pending", attempts: 1, claimed: false }],
        error: null,
      }),
    }) as unknown as SupabaseClient);
    await expect(impossibleClaim.claimAlert({
      alertKey: "deadline:wechat",
      date: "2026-07-15",
      leaseSeconds: 300,
      now: "2026-07-15T15:45:00.000Z",
      workerId,
    })).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "delivery.alert.claim",
    });

    const wrongCompletion = createDeliveryHealthStore(async () => ({
      rpc: vi.fn().mockResolvedValue({ data: [{ alert_status: "pending" }], error: null }),
    }) as unknown as SupabaseClient);
    await expect(wrongCompletion.finishAlert({
      alertKey: "deadline:wechat",
      date: "2026-07-15",
      error: null,
      outcome: "success",
      workerId,
    })).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "delivery.alert.finish",
    });
  });
});
