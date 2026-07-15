import { randomUUID } from "node:crypto";
import { getClient } from "./supabase.ts";
import { databaseData, isDatabaseUuid, assertDatabaseIntegrity } from "./db-result.ts";
import { loadOptionalSMTPConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment, type RuntimeEnvironment } from "./runtime-env.ts";

export type DeliveryChannel = "email" | "wechat";

export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly digestDate: string;
  readonly channel: DeliveryChannel;
  readonly providerId: "smtp" | "serverchan";
  readonly idempotencyKey: string;
  readonly payload: { title: string; markdown: string };
  readonly attempts: number;
}

function row(value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity("delivery.outbox", value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function oneRow(value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity("delivery.outbox", Array.isArray(value) && value.length === 1);
  return row(value[0]);
}

export function deliveryDateFromTitle(title: string): string {
  const date = title.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (!date) throw new Error("Delivery title must include an ISO digest date");
  return date;
}

function validDigestDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

function configuredChannels(environment: RuntimeEnvironment): readonly DeliveryChannel[] {
  return Object.freeze([
    "wechat" as const,
    ...(loadOptionalSMTPConfig(environment) ? ["email" as const] : []),
  ]);
}

function payload(title: string, markdown: string): Record<string, string> {
  if (!title.trim() || Buffer.byteLength(title, "utf8") > 200 || !markdown.trim() || Buffer.byteLength(markdown, "utf8") > 1_048_576) {
    throw new Error("Delivery payload is invalid");
  }
  return { title, markdown };
}

export async function enqueueDigestDeliveries(
  title: string,
  markdown: string,
  environment: RuntimeEnvironment = currentRuntimeEnvironment(),
  pipelineRunId?: string,
): Promise<void> {
  if (pipelineRunId !== undefined && !isDatabaseUuid(pipelineRunId)) {
    throw new Error("Pipeline run id is invalid");
  }
  const digestDate = deliveryDateFromTitle(title);
  const message = payload(title, markdown);
  const channels = configuredChannels(environment).map((channel) => [
    channel,
    channel === "email" ? "smtp" as const : "serverchan" as const,
  ] as const);
  const db = await getClient();
  for (const [channel, providerId] of channels) {
    const data = databaseData(
      `delivery.enqueue.${channel}`,
      await db.rpc(pipelineRunId ? "enqueue_pipeline_delivery" : "enqueue_delivery", {
        p_channel: channel,
        p_digest_date: digestDate,
        p_idempotency_key: `digest:${digestDate}:${channel}`,
        p_payload: message,
        p_provider_id: providerId,
        ...(pipelineRunId ? { p_run_id: pipelineRunId } : {}),
      }),
    );
    const record = oneRow(data);
    assertDatabaseIntegrity(
      `delivery.enqueue.${channel}`,
      isDatabaseUuid(record.delivery_id) &&
        (record.delivery_status === "pending" || record.delivery_status === "in_flight" || record.delivery_status === "succeeded" || record.delivery_status === "failed") &&
        typeof record.inserted === "boolean",
    );
  }
}

function parseClaimedDeliveries(operation: string, data: unknown): ClaimedDelivery[] {
  assertDatabaseIntegrity(operation, Array.isArray(data));
  return data.map((value) => {
    const record = row(value);
    const rawPayload = row(record.payload);
    assertDatabaseIntegrity(
      operation,
      isDatabaseUuid(record.delivery_id) &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(record.digest_date)) &&
        (record.channel === "email" || record.channel === "wechat") &&
        (record.provider_id === "smtp" || record.provider_id === "serverchan") &&
        typeof record.idempotency_key === "string" &&
        typeof rawPayload.title === "string" &&
        typeof rawPayload.markdown === "string" &&
        typeof record.attempts === "number" &&
        Number.isInteger(record.attempts) &&
        record.attempts >= 1,
    );
    return {
      deliveryId: record.delivery_id as string,
      digestDate: record.digest_date as string,
      channel: record.channel as DeliveryChannel,
      providerId: record.provider_id as "smtp" | "serverchan",
      idempotencyKey: record.idempotency_key as string,
      payload: { title: rawPayload.title as string, markdown: rawPayload.markdown as string },
      attempts: record.attempts as number,
    };
  });
}

export async function claimDeliveries(workerId: string = randomUUID()): Promise<ClaimedDelivery[]> {
  if (!isDatabaseUuid(workerId)) throw new Error("Delivery worker id is invalid");
  const db = await getClient();
  const data = databaseData(
    "delivery.claim",
    await db.rpc("claim_delivery", {
      p_limit: 10,
      p_lease_seconds: 300,
      p_now: new Date().toISOString(),
      p_worker_id: workerId,
    }),
  );
  return parseClaimedDeliveries("delivery.claim", data);
}

export async function claimDigestDeliveries(
  digestDate: string,
  workerId: string = randomUUID(),
): Promise<ClaimedDelivery[]> {
  if (!validDigestDate(digestDate) || !isDatabaseUuid(workerId)) {
    throw new Error("Digest delivery identity is invalid");
  }
  const db = await getClient();
  const data = databaseData(
    "delivery.claimDigest",
    await db.rpc("claim_digest_delivery", {
      p_digest_date: digestDate,
      p_limit: 10,
      p_lease_seconds: 300,
      p_now: new Date().toISOString(),
      p_worker_id: workerId,
    }),
  );
  return parseClaimedDeliveries("delivery.claimDigest", data);
}

export async function requeueFailedDigestDeliveries(
  digestDate: string,
  environment: RuntimeEnvironment = currentRuntimeEnvironment(),
): Promise<number> {
  if (!validDigestDate(digestDate)) throw new Error("Digest delivery date is invalid");
  const db = await getClient();
  const data = databaseData(
    "delivery.requeueFailed",
    await db.rpc("requeue_failed_deliveries", {
      p_channels: configuredChannels(environment),
      p_digest_date: digestDate,
      p_now: new Date().toISOString(),
    }),
  );
  assertDatabaseIntegrity("delivery.requeueFailed", Array.isArray(data));
  for (const value of data) {
    const record = row(value);
    assertDatabaseIntegrity(
      "delivery.requeueFailed",
      isDatabaseUuid(record.delivery_id) &&
        (record.channel === "email" || record.channel === "wechat") &&
        record.delivery_status === "pending" &&
        Number.isInteger(record.attempts) &&
        Number.isInteger(record.requeue_count) &&
        (record.requeue_count as number) >= 1,
    );
  }
  return data.length;
}

export async function finishDelivery(
  deliveryId: string,
  workerId: string,
  outcome: "success" | "retry" | "permanent",
  options: { providerMessageId?: string; error?: string; nextAttemptAt?: Date } = {},
): Promise<"succeeded" | "pending" | "failed"> {
  if (!isDatabaseUuid(deliveryId) || !isDatabaseUuid(workerId)) throw new Error("Delivery identity is invalid");
  const db = await getClient();
  const data = databaseData(
    "delivery.finish",
    await db.rpc("finish_delivery", {
      p_delivery_id: deliveryId,
      p_error: options.error?.slice(0, 2_048) ?? null,
      p_next_attempt_at: options.nextAttemptAt?.toISOString() ?? null,
      p_outcome: outcome,
      p_provider_message_id: options.providerMessageId?.slice(0, 200) ?? null,
      p_worker_id: workerId,
    }),
  );
  const record = oneRow(data);
  const expected = outcome === "success" ? "succeeded" : outcome === "retry" ? "pending" : "failed";
  assertDatabaseIntegrity("delivery.finish", record.delivery_id === deliveryId && record.delivery_status === expected && Number.isInteger(record.attempts));
  return expected;
}

export function retryAt(attempts: number, now = Date.now()): Date {
  const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, Math.min(10, attempts - 1)));
  return new Date(now + delay);
}
