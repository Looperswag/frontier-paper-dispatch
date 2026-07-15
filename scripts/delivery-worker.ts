import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootConfig } from "../lib/runtime-config.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";
import { sendFailureAlert, type AlertEvent } from "../lib/alert.ts";
import {
  currentRuntimeEnvironment,
  loadRuntimeEnvironment,
  withRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../lib/runtime-env.ts";
import {
  processPendingDeliveries,
  type DeliveryAttemptReport,
} from "./digest.ts";
import {
  checkDeliveryDeadline,
  type DeliveryHealthReport,
} from "../lib/delivery-health.ts";

type HealthCheck = (environment: RuntimeEnvironment) => Promise<DeliveryHealthReport>;
type WorkerRunner = (environment: RuntimeEnvironment) => Promise<DeliveryAttemptReport>;
type AlertSender = (
  event: AlertEvent,
  environment: RuntimeEnvironment,
) => Promise<boolean>;
type EnvironmentLoader = (baseEnvironment: RuntimeEnvironment) => RuntimeEnvironment;

export async function runDeliveryWorker(
  injectedEnv?: RuntimeEnvironment,
  processPending: () => Promise<DeliveryAttemptReport> = processPendingDeliveries,
  checkHealth: HealthCheck = (environment) => checkDeliveryDeadline({ environment }),
): Promise<DeliveryAttemptReport> {
  const environment = injectedEnv ?? loadRuntimeEnvironment();
  return withRuntimeEnvironment(environment, async () => {
    loadRootConfig("deliver", currentRuntimeEnvironment());
    const report = await processPending();
    const health = await checkHealth(environment);
    console.log(
      `delivery worker: attempted=${report.attempted} succeeded=${report.succeeded.length} retried=${report.retried.length}`,
    );
    console.log(
      `delivery health: date=${health.date} status=${health.status} missing=${health.missing.join(",") || "none"}`,
    );
    return report;
  });
}

export async function runDeliveryWorkerEntry(
  baseEnvironment: RuntimeEnvironment = process.env,
  worker: WorkerRunner = runDeliveryWorker,
  sendAlert: AlertSender = sendFailureAlert,
  loadEnvironment: EnvironmentLoader = (base) => loadRuntimeEnvironment({ baseEnv: base }),
): Promise<void> {
  let environment: RuntimeEnvironment | undefined;
  try {
    environment = loadEnvironment(baseEnvironment);
    await worker(environment);
  } catch (error) {
    const scopedEnvironment = environment ?? baseEnvironment;
    const detail = safeErrorMessage(error, scopedEnvironment);
    console.error(`delivery worker failed: ${detail}`);
    await sendAlert({
      detail,
      event: "delivery_worker_failed",
      severity: "critical",
    }, scopedEnvironment);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDeliveryWorkerEntry();
}
