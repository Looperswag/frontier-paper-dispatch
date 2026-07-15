import { afterEach, expect, test, vi } from "vitest";
import type { DeliveryAttemptReport } from "../../scripts/digest.ts";
import {
  runDeliveryWorker,
  runDeliveryWorkerEntry,
} from "../../scripts/delivery-worker.ts";
import type { DeliveryHealthReport } from "../../lib/delivery-health.ts";

const environment = {
  SERVERCHAN_SENDKEY: `SCT${"w".repeat(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
  SUPABASE_URL: "https://delivery-worker.supabase.co",
};

afterEach(() => vi.restoreAllMocks());

test("independent delivery worker processes pending jobs without enqueueing a digest", async () => {
  const report: DeliveryAttemptReport = {
    attempted: 0,
    permanentFailures: [],
    retried: [],
    succeeded: [],
  };
  const processPending = vi.fn().mockResolvedValue(report);
  const checkHealth = vi.fn().mockResolvedValue({
    date: "2026-07-15",
    missing: [],
    status: "not_due",
  } satisfies DeliveryHealthReport);
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  await expect(runDeliveryWorker(environment, processPending, checkHealth)).resolves.toEqual(report);
  expect(processPending).toHaveBeenCalledOnce();
  expect(checkHealth).toHaveBeenCalledWith(environment);
  expect(console.log).toHaveBeenCalledWith("delivery worker: attempted=0 succeeded=0 retried=0");
  expect(console.log).toHaveBeenCalledWith("delivery health: date=2026-07-15 status=not_due missing=none");
});

test("delivery worker fails closed before claiming when required provider config is absent", async () => {
  const processPending = vi.fn();

  await expect(runDeliveryWorker({
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
    SUPABASE_URL: "https://delivery-worker.supabase.co",
  }, processPending)).rejects.toMatchObject({ code: "INVALID_RUNTIME_CONFIG" });
  expect(processPending).not.toHaveBeenCalled();
});

test("entrypoint alerts independently when the worker fails before a database claim", async () => {
  const failure = new Error("database unavailable");
  const worker = vi.fn().mockRejectedValue(failure);
  const sendAlert = vi.fn().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await runDeliveryWorkerEntry(environment, worker, sendAlert, (base) => base);

    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "database unavailable",
        event: "delivery_worker_failed",
        severity: "critical",
      }),
      environment,
    );
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
