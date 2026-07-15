import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendFailureAlert, type AlertEvent } from "./alert.ts";
import { assertDatabaseIntegrity, databaseData, isDatabaseUuid } from "./db-result.ts";
import { loadOptionalSMTPConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment, type RuntimeEnvironment } from "./runtime-env.ts";
import { getClient } from "./supabase.ts";
import { shanghaiDateKey, SHANGHAI_TIME_ZONE } from "./time.ts";

export type DeliveryHealthChannel = "email" | "wechat";
type DeliveryStatus = "failed" | "in_flight" | "pending" | "succeeded";
type AlertLedgerStatus = "in_flight" | "pending" | "succeeded";

export interface DeliveryHealthRow {
  readonly attempts: number;
  readonly channel: DeliveryHealthChannel;
  readonly deliveredAt: string | null;
  readonly status: DeliveryStatus;
}

export interface DeliveryAlertClaim {
  readonly attempts: number;
  readonly claimed: boolean;
  readonly status: AlertLedgerStatus;
}

export interface ClaimDeliveryAlertInput {
  readonly alertKey: string;
  readonly date: string;
  readonly leaseSeconds: number;
  readonly now: string;
  readonly workerId: string;
}

export interface FinishDeliveryAlertInput {
  readonly alertKey: string;
  readonly date: string;
  readonly error: string | null;
  readonly outcome: "retry" | "success";
  readonly workerId: string;
}

export interface DeliveryHealthStore {
  getHealth(date: string): Promise<readonly DeliveryHealthRow[]>;
  claimAlert(input: ClaimDeliveryAlertInput): Promise<DeliveryAlertClaim>;
  finishAlert(input: FinishDeliveryAlertInput): Promise<"pending" | "succeeded">;
}

export interface DeliveryHealthReport {
  readonly date: string;
  readonly missing: readonly DeliveryHealthChannel[];
  readonly status: "alerted" | "already_claimed" | "healthy" | "not_due" | "retry";
}

type RpcClient = Pick<SupabaseClient, "rpc">;
type AlertSender = (
  event: AlertEvent,
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<boolean>;

const shanghaiTimeFormatter = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn-hc-h23", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: SHANGHAI_TIME_ZONE,
});

function record(operation: string, value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity(
    operation,
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function oneRow(operation: string, value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity(operation, Array.isArray(value) && value.length === 1);
  return record(operation, value[0]);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function deadlineReached(now: Date): boolean {
  // shanghaiDateKey owns the invalid-Date check and keeps both formatters on one time zone.
  shanghaiDateKey(now);
  const parts = Object.fromEntries(
    shanghaiTimeFormatter
      .formatToParts(now)
      .filter(({ type }) => type === "hour" || type === "minute")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return parts.hour > 23 || (parts.hour === 23 && parts.minute >= 30);
}

function latestDueDeliveryDate(now: Date): string {
  if (deadlineReached(now)) return shanghaiDateKey(now);
  // Shanghai has no DST. Before today's deadline, yesterday is the latest
  // delivery whose deadline has elapsed; this catches a Mac waking after midnight.
  return shanghaiDateKey(new Date(now.getTime() - 86_400_000));
}

function requiredChannels(environment: RuntimeEnvironment): readonly DeliveryHealthChannel[] {
  return Object.freeze([
    ...(loadOptionalSMTPConfig(environment) ? ["email" as const] : []),
    "wechat" as const,
  ]);
}

function parseHealthRows(value: unknown): readonly DeliveryHealthRow[] {
  assertDatabaseIntegrity("delivery.health", Array.isArray(value));
  return Object.freeze(value.map((entry) => {
    const raw = record("delivery.health", entry);
    assertDatabaseIntegrity(
      "delivery.health",
      (raw.channel === "email" || raw.channel === "wechat") &&
        (raw.status === "failed" ||
          raw.status === "in_flight" ||
          raw.status === "pending" ||
          raw.status === "succeeded") &&
        Number.isInteger(raw.attempts) &&
        (raw.attempts as number) >= 0 &&
        (raw.attempts as number) <= 100 &&
        (raw.delivered_at === null || validTimestamp(raw.delivered_at)) &&
        (raw.status !== "succeeded" || validTimestamp(raw.delivered_at)),
    );
    return Object.freeze({
      attempts: raw.attempts as number,
      channel: raw.channel as DeliveryHealthChannel,
      deliveredAt: raw.delivered_at as string | null,
      status: raw.status as DeliveryStatus,
    });
  }));
}

export function createDeliveryHealthStore(
  clientFactory: () => Promise<RpcClient> = getClient,
): DeliveryHealthStore {
  return Object.freeze({
    async getHealth(date: string): Promise<readonly DeliveryHealthRow[]> {
      const client = await clientFactory();
      const result = await client.rpc("get_delivery_health", { p_digest_date: date });
      return parseHealthRows(databaseData("delivery.health", result));
    },

    async claimAlert(input: ClaimDeliveryAlertInput): Promise<DeliveryAlertClaim> {
      const client = await clientFactory();
      const result = await client.rpc("claim_delivery_alert", {
        p_alert_date: input.date,
        p_alert_key: input.alertKey,
        p_lease_seconds: input.leaseSeconds,
        p_now: input.now,
        p_worker_id: input.workerId,
      });
      const raw = oneRow(
        "delivery.alert.claim",
        databaseData("delivery.alert.claim", result),
      );
      assertDatabaseIntegrity(
        "delivery.alert.claim",
        typeof raw.claimed === "boolean" &&
          (raw.alert_status === "in_flight" ||
            raw.alert_status === "pending" ||
            raw.alert_status === "succeeded") &&
          (raw.claimed
            ? raw.alert_status === "in_flight"
            : raw.alert_status === "in_flight" || raw.alert_status === "succeeded") &&
          Number.isInteger(raw.attempts) &&
          (raw.attempts as number) >= 0 &&
          (raw.attempts as number) <= 1_000,
      );
      return Object.freeze({
        attempts: raw.attempts as number,
        claimed: raw.claimed,
        status: raw.alert_status as AlertLedgerStatus,
      });
    },

    async finishAlert(input: FinishDeliveryAlertInput): Promise<"pending" | "succeeded"> {
      const client = await clientFactory();
      const result = await client.rpc("finish_delivery_alert", {
        p_alert_date: input.date,
        p_alert_key: input.alertKey,
        p_error: input.error,
        p_outcome: input.outcome,
        p_worker_id: input.workerId,
      });
      const raw = oneRow(
        "delivery.alert.finish",
        databaseData("delivery.alert.finish", result),
      );
      const expectedStatus = input.outcome === "success" ? "succeeded" : "pending";
      assertDatabaseIntegrity(
        "delivery.alert.finish",
        raw.alert_status === expectedStatus,
      );
      return expectedStatus;
    },
  });
}

const defaultStore = createDeliveryHealthStore();

export interface CheckDeliveryDeadlineOptions {
  readonly environment?: RuntimeEnvironment;
  readonly now?: Date;
  readonly sendAlert?: AlertSender;
  readonly store?: DeliveryHealthStore;
  readonly workerId?: string;
}

/** Check the latest delivery date whose 23:30 Asia/Shanghai deadline has elapsed. */
export async function checkDeliveryDeadline(
  options: CheckDeliveryDeadlineOptions = {},
): Promise<DeliveryHealthReport> {
  const environment = options.environment ?? currentRuntimeEnvironment();
  const now = options.now ?? new Date();
  const date = latestDueDeliveryDate(now);

  const database = options.store ?? defaultStore;
  const health = await database.getHealth(date);
  const missing = requiredChannels(environment).filter(
    (required) => !health.some(
      (delivery) => delivery.channel === required && delivery.status === "succeeded",
    ),
  );
  if (!missing.length) {
    return Object.freeze({ date, missing: Object.freeze([]), status: "healthy" });
  }

  const workerId = options.workerId ?? randomUUID();
  if (!isDatabaseUuid(workerId)) throw new Error("Delivery alert worker id is invalid");
  const alertKey = `deadline:${missing.join(",")}`;
  const claim = await database.claimAlert({
    alertKey,
    date,
    leaseSeconds: 300,
    now: now.toISOString(),
    workerId,
  });
  if (!claim.claimed) {
    return Object.freeze({
      date,
      missing: Object.freeze([...missing]),
      status: "already_claimed",
    });
  }

  const event: AlertEvent = Object.freeze({
    correlationId: `delivery-deadline:${date}:${missing.join(",")}`,
    detail: `missing_channels=${missing.join(",")}; deadline=23:30 ${SHANGHAI_TIME_ZONE}`,
    event: "delivery_deadline_missed",
    runDate: date,
    severity: "critical",
  });
  let sent = false;
  try {
    sent = await (options.sendAlert ?? sendFailureAlert)(event, environment);
  } catch {
    // Custom alert transports follow the same retry contract as the built-in non-throwing sender.
  }
  await database.finishAlert({
    alertKey,
    date,
    error: sent ? null : "Alert webhook delivery failed",
    outcome: sent ? "success" : "retry",
    workerId,
  });
  return Object.freeze({
    date,
    missing: Object.freeze([...missing]),
    status: sent ? "alerted" : "retry",
  });
}
