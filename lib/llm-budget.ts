import { loadSupabaseConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment } from "./runtime-env.ts";

const RPC_DEADLINE_MS = 5_000;
const MAX_RPC_RESPONSE_BYTES = 8_192;
const MAX_LLM_TOKENS = 65_536;
const MAX_DAILY_RETRY_SECONDS = 86_400;

const DATABASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RootLLMPolicy = "root_rank" | "root_summary" | "root_refine";
export type RootLLMSubject = "system:ingest" | "system:refine";

export interface RootLLMBudgetReservation {
  readonly budgetDate: string;
  readonly reservationId: string;
  readonly reservedTokens: number;
  readonly subject: RootLLMSubject;
}

export type RootLLMBudgetResult =
  | Readonly<({ allowed: true } & RootLLMBudgetReservation)>
  | Readonly<{ allowed: false; retryAfter: number }>;

function unavailable(): never {
  throw new Error("LLM_BUDGET_UNAVAILABLE");
}

function safely<T>(operation: () => Promise<T>): Promise<T> {
  const result = (async () => {
    try {
      return await operation();
    } catch {
      return unavailable();
    }
  })();
  // A deadline may reject before orchestration reaches its await. Observing the
  // promise here prevents a transient unhandled-rejection report without
  // changing the rejection returned to the caller.
  void result.catch(() => {});
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function oneRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) return unavailable();
  return record(value[0]) ?? unavailable();
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

function validPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function subjectFor(policy: RootLLMPolicy): RootLLMSubject {
  return policy === "root_refine" ? "system:refine" : "system:ingest";
}

function validPolicy(value: unknown): value is RootLLMPolicy {
  return value === "root_rank" || value === "root_summary" || value === "root_refine";
}

function cancelResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; validation still fails closed.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; validation still fails closed.
  }
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<typeof reader.read> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cancelReader(reader);
      reject(new Error("LLM_BUDGET_ABORTED"));
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

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !jsonContentType(response.headers.get("content-type"))) {
    cancelResponse(response);
    throw new Error("INVALID_LLM_BUDGET_RESPONSE");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/.test(declaredLength) || Number(declaredLength) > MAX_RPC_RESPONSE_BYTES)
  ) {
    cancelResponse(response);
    throw new Error("INVALID_LLM_BUDGET_RESPONSE");
  }

  const body = response.body;
  if (!body) throw new Error("INVALID_LLM_BUDGET_RESPONSE");
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
        throw new Error("INVALID_LLM_BUDGET_RESPONSE");
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
      // A hostile stream may retain its lock; the response is still rejected.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function rpc(
  name: "reserve_llm_budget" | "settle_llm_budget",
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const config = loadSupabaseConfig(currentRuntimeEnvironment());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_DEADLINE_MS);
  try {
    const response = await globalThis.fetch(`${config.url}/rest/v1/rpc/${name}`, {
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
    return await boundedJSON(response, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function reserveRootLLMBudget(
  policy: RootLLMPolicy,
  requestId: string,
  reservedTokens: number,
): Promise<RootLLMBudgetResult> {
  return safely(async () => {
    if (
      !validPolicy(policy) ||
      typeof requestId !== "string" ||
      !DATABASE_UUID_V4.test(requestId) ||
      !validPositiveInteger(reservedTokens, MAX_LLM_TOKENS)
    ) {
      return unavailable();
    }
    const subject = subjectFor(policy);
    const row = oneRow(
      await rpc("reserve_llm_budget", {
        p_policy: policy,
        p_request_id: requestId,
        p_reserved_tokens: reservedTokens,
        p_subject: subject,
      }),
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
        subject,
      });
    }

    if (
      row.outcome !== "budget_exhausted" ||
      row.reservation_id !== null ||
      row.reserved_tokens !== null ||
      !validPositiveInteger(row.retry_after_seconds, MAX_DAILY_RETRY_SECONDS)
    ) {
      return unavailable();
    }
    return Object.freeze({ allowed: false, retryAfter: row.retry_after_seconds });
  });
}

export function settleRootLLMBudget(
  reservation: RootLLMBudgetReservation,
  actualTokens: number | null,
): Promise<Readonly<{ chargedTokens: number }>> {
  return safely(async () => {
    const value = record(reservation);
    if (
      value === undefined ||
      !validDateKey(value.budgetDate) ||
      typeof value.reservationId !== "string" ||
      !DATABASE_UUID_V4.test(value.reservationId) ||
      !validPositiveInteger(value.reservedTokens, MAX_LLM_TOKENS) ||
      (value.subject !== "system:ingest" && value.subject !== "system:refine") ||
      (actualTokens !== null &&
        !validPositiveInteger(actualTokens, value.reservedTokens as number))
    ) {
      return unavailable();
    }

    const row = oneRow(
      await rpc("settle_llm_budget", {
        p_actual_tokens: actualTokens,
        p_reservation_id: value.reservationId,
        p_subject: value.subject,
      }),
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
