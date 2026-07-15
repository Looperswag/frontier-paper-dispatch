import "server-only";

import type { OwnerContext } from "@/lib/auth";
import { getQuotaConfig } from "@/lib/config.server";
import { clientIPFingerprint } from "@/lib/request-identity";
import { normalizeAuthEmail } from "@/lib/runtime-config";

const QUOTA_DEADLINE_MS = 5_000;
const MAX_RPC_RESPONSE_BYTES = 8_192;
const MAX_LLM_TOKENS = 65_536;
const MAX_DAILY_RETRY_SECONDS = 86_400;

const DATABASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IP_FINGERPRINT = /^v([1-9][0-9]{0,5}):[0-9a-f]{64}$/;

export type APIRateLimitPolicy = "auth_login" | "owner_write" | "web_chat";

export type APIRateLimitResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAfter: number }>;

export interface LLMBudgetReservation {
  readonly budgetDate: string;
  readonly reservationId: string;
  readonly reservedTokens: number;
}

export type LLMBudgetResult =
  | Readonly<({ allowed: true } & LLMBudgetReservation)>
  | Readonly<{ allowed: false; retryAfter: number }>;

type QuotaConfig = Readonly<{
  secret: string;
  secretVersion: number;
  serviceRoleKey: string;
  url: string;
}>;

function unavailable(): never {
  throw new Error("QUOTA_UNAVAILABLE");
}

function safely<T>(operation: () => Promise<T>): Promise<T> {
  const result = (async () => {
    try {
      return await operation();
    } catch {
      return unavailable();
    }
  })();
  // Quota deadlines can reject before a route attaches its await handler. This
  // observer prevents a transient unhandled-rejection report without changing
  // the rejected promise returned to the caller.
  void result.catch(() => {});
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match || !validDateKey(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value))
  );
}

function validOwner(owner: unknown): owner is OwnerContext {
  const value = record(owner);
  return (
    value !== undefined &&
    typeof value.email === "string" &&
    normalizeAuthEmail(value.email) === value.email &&
    typeof value.userId === "string" &&
    DATABASE_UUID.test(value.userId)
  );
}

function validLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function quotaConfig(): QuotaConfig {
  const config: unknown = getQuotaConfig();
  const value = record(config);
  if (
    value === undefined ||
    typeof value.secret !== "string" ||
    new TextEncoder().encode(value.secret).byteLength < 32 ||
    /[\u0000-\u001f\u007f]/.test(value.secret) ||
    !Number.isInteger(value.secretVersion) ||
    (value.secretVersion as number) < 1 ||
    (value.secretVersion as number) > 999_999 ||
    typeof value.serviceRoleKey !== "string" ||
    value.serviceRoleKey.length < 24 ||
    !/^[\x21-\x7e]+$/.test(value.serviceRoleKey) ||
    /^sb_publishable_/i.test(value.serviceRoleKey) ||
    typeof value.url !== "string"
  ) {
    return unavailable();
  }

  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return unavailable();
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && validLoopback(url.hostname)))
  ) {
    return unavailable();
  }

  return Object.freeze({
    secret: value.secret,
    secretVersion: value.secretVersion as number,
    serviceRoleKey: value.serviceRoleKey,
    url: url.origin,
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; the response still fails closed.
  }
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cancelReader(reader);
      reject(new Error("QUOTA_ABORTED"));
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    try {
      void reader.read().then(
        (result) => {
          signal.removeEventListener("abort", aborted);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener("abort", aborted);
      reject(error);
    }
  });
}

function jsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

function cancelResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; no upstream payload is exposed.
  }
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !jsonContentType(response.headers.get("content-type"))) {
    cancelResponse(response);
    throw new Error("INVALID_QUOTA_RESPONSE");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/.test(declaredLength) || Number(declaredLength) > MAX_RPC_RESPONSE_BYTES)
  ) {
    cancelResponse(response);
    throw new Error("INVALID_QUOTA_RESPONSE");
  }

  const body = response.body;
  if (!body) throw new Error("INVALID_QUOTA_RESPONSE");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RPC_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new Error("INVALID_QUOTA_RESPONSE");
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Hostile streams can keep cancellation pending; validation still fails.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(decoded) as unknown;
}

async function quotaRPC(
  rpc: "consume_api_rate_limits" | "reserve_llm_budget" | "settle_llm_budget",
  payload: Readonly<Record<string, unknown>>,
  config: QuotaConfig,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  if (callerSignal?.aborted) throw new Error("QUOTA_ABORTED");

  const controller = new AbortController();
  const abort = () => controller.abort();
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = () => rejectAbort?.(new Error("QUOTA_ABORTED"));
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) controller.abort();
  const timeout = setTimeout(abort, QUOTA_DEADLINE_MS);

  const operation = (async () => {
    const response = await globalThis.fetch(`${config.url}/rest/v1/rpc/${rpc}`, {
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    return boundedJSON(response, controller.signal);
  })();

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) return unavailable();
  return record(value[0]) ?? unavailable();
}

function validRetry(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function rateRetryMaximum(policy: APIRateLimitPolicy): number {
  return policy === "auth_login" ? 900 : 60;
}

export function consumeAPIRateLimit(
  request: Request,
  policy: APIRateLimitPolicy,
  owner?: OwnerContext,
): Promise<APIRateLimitResult> {
  return safely(async () => {
    if (
      !(request instanceof Request) ||
      request.signal.aborted ||
      (policy !== "auth_login" && policy !== "owner_write" && policy !== "web_chat") ||
      (policy === "auth_login" ? owner !== undefined : !validOwner(owner))
    ) {
      return unavailable();
    }

    const config = quotaConfig();
    const fingerprint = clientIPFingerprint(request, {
      secret: config.secret,
      secretVersion: config.secretVersion,
    });
    const fingerprintMatch = IP_FINGERPRINT.exec(fingerprint);
    if (!fingerprintMatch || Number(fingerprintMatch[1]) !== config.secretVersion) {
      return unavailable();
    }

    const row = oneRow(
      await quotaRPC(
        "consume_api_rate_limits",
        {
          p_ip_fingerprint: fingerprint,
          p_policy: policy,
          p_user_id: owner?.userId ?? null,
        },
        config,
        request.signal,
      ),
    );
    if (!exactKeys(row, ["outcome", "reset_at", "retry_after_seconds"])) {
      return unavailable();
    }
    if (row.outcome === "allowed") {
      if (row.reset_at !== null || row.retry_after_seconds !== null) return unavailable();
      return Object.freeze({ allowed: true });
    }
    if (
      row.outcome !== "rate_limited" ||
      !validTimestamp(row.reset_at) ||
      !validRetry(row.retry_after_seconds, rateRetryMaximum(policy))
    ) {
      return unavailable();
    }
    return Object.freeze({ allowed: false, retryAfter: row.retry_after_seconds });
  });
}

export function reserveLLMBudget(
  request: Request,
  owner: OwnerContext,
  requestId: string,
  reservedTokens: number,
): Promise<LLMBudgetResult> {
  return safely(async () => {
    if (
      !(request instanceof Request) ||
      request.signal.aborted ||
      !validOwner(owner) ||
      typeof requestId !== "string" ||
      !DATABASE_UUID_V4.test(requestId) ||
      !Number.isInteger(reservedTokens) ||
      reservedTokens < 1 ||
      reservedTokens > MAX_LLM_TOKENS
    ) {
      return unavailable();
    }

    const config = quotaConfig();
    const row = oneRow(
      await quotaRPC(
        "reserve_llm_budget",
        {
          p_policy: "web_chat",
          p_request_id: requestId,
          p_reserved_tokens: reservedTokens,
          p_subject: owner.userId,
        },
        config,
        request.signal,
      ),
    );
    if (
      !exactKeys(row, [
        "budget_date",
        "outcome",
        "reservation_id",
        "reserved_tokens",
        "retry_after_seconds",
      ]) ||
      !validDateKey(row.budget_date)
    ) {
      return unavailable();
    }
    if (row.outcome === "reserved" || row.outcome === "existing") {
      if (
        typeof row.reservation_id !== "string" ||
        !DATABASE_UUID_V4.test(row.reservation_id) ||
        row.reserved_tokens !== reservedTokens ||
        row.retry_after_seconds !== null
      ) {
        return unavailable();
      }
      return Object.freeze({
        allowed: true,
        budgetDate: row.budget_date,
        reservationId: row.reservation_id,
        reservedTokens,
      });
    }
    if (
      row.outcome !== "budget_exhausted" ||
      row.reservation_id !== null ||
      row.reserved_tokens !== null ||
      !validRetry(row.retry_after_seconds, MAX_DAILY_RETRY_SECONDS)
    ) {
      return unavailable();
    }
    return Object.freeze({ allowed: false, retryAfter: row.retry_after_seconds });
  });
}

export function settleLLMBudget(
  owner: OwnerContext,
  reservation: LLMBudgetReservation,
  actualTokens: number | null,
): Promise<Readonly<{ chargedTokens: number }>> {
  return safely(async () => {
    const value = record(reservation);
    if (
      !validOwner(owner) ||
      value === undefined ||
      !validDateKey(value.budgetDate) ||
      typeof value.reservationId !== "string" ||
      !DATABASE_UUID_V4.test(value.reservationId) ||
      !Number.isInteger(value.reservedTokens) ||
      (value.reservedTokens as number) < 1 ||
      (value.reservedTokens as number) > MAX_LLM_TOKENS ||
      (actualTokens !== null &&
        (!Number.isInteger(actualTokens) ||
          actualTokens < 1 ||
          actualTokens > (value.reservedTokens as number)))
    ) {
      return unavailable();
    }

    const config = quotaConfig();
    const row = oneRow(
      await quotaRPC(
        "settle_llm_budget",
        {
          p_actual_tokens: actualTokens,
          p_reservation_id: value.reservationId,
          p_subject: owner.userId,
        },
        config,
      ),
    );
    const expectedCharge = actualTokens ?? (value.reservedTokens as number);
    if (
      !exactKeys(row, ["budget_date", "charged_tokens", "outcome"]) ||
      (row.outcome !== "settled" && row.outcome !== "existing") ||
      row.budget_date !== value.budgetDate ||
      row.charged_tokens !== expectedCharge
    ) {
      return unavailable();
    }
    return Object.freeze({ chargedTokens: expectedCharge });
  });
}
