// LLM 封装 —— DeepSeek（OpenAI 兼容协议）。动态/惰性 import，使 `--dry` 路径无需配置密钥。
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import {
  reserveRootLLMBudget,
  settleRootLLMBudget,
  type RootLLMPolicy,
} from "./llm-budget.ts";
import { loadDeepSeekConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment } from "./runtime-env.ts";

// deepseek-chat = DeepSeek-V3（通用）；如需更强推理可换 deepseek-reasoner（更慢/不支持 json 模式）。
export const MODELS = {
  rank: "deepseek-chat",
  summarize: "deepseek-chat",
} as const;

const clients = new WeakMap<object, OpenAI>();
const MAX_DISPATCH_TOKENS = 65_536;
const DEFAULT_MAX_TOKENS = 4_096;
const PROVIDER_TIMEOUT_MS = 45_000;
const STRUCTURED_OUTPUT_DEADLINE_MS = 120_000;

export type LLMOperationErrorCode =
  | "LLM_BUDGET_EXHAUSTED"
  | "LLM_BUDGET_UNAVAILABLE"
  | "LLM_INPUT_TOO_LARGE"
  | "LLM_PROVIDER_INVALID"
  | "LLM_PROVIDER_REQUEST_FAILED";

export class LLMOperationError extends Error {
  readonly code: LLMOperationErrorCode;
  readonly retryAfter?: number;

  constructor(code: LLMOperationErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.name = "LLMOperationError";
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function getClient(): OpenAI {
  const environment = currentRuntimeEnvironment();
  const existing = clients.get(environment);
  if (existing) return existing;
  const config = loadDeepSeekConfig(environment);
  // SDK retries are disabled because every physical provider attempt needs its
  // own database reservation. JSON retries below are explicit and budgeted.
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: PROVIDER_TIMEOUT_MS,
  });
  clients.set(environment, client);
  return client;
}

function reservationUpperBound(system: string, user: string, maxTokens: number): number {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_DISPATCH_TOKENS) {
    throw new LLMOperationError("LLM_INPUT_TOO_LARGE", "LLM dispatch is too large");
  }
  // UTF-8 bytes are a conservative upper bound for input tokens. The fixed
  // allowance covers message framing and provider-side tokenization overhead.
  const estimate =
    Buffer.byteLength(system, "utf8") +
    Buffer.byteLength(user, "utf8") +
    maxTokens +
    4_096 +
    256;
  if (!Number.isSafeInteger(estimate) || estimate > MAX_DISPATCH_TOKENS) {
    throw new LLMOperationError("LLM_INPUT_TOO_LARGE", "LLM dispatch is too large");
  }
  return estimate;
}

async function settleOrFail(
  reservation: Parameters<typeof settleRootLLMBudget>[0],
  actualTokens: number | null,
): Promise<void> {
  try {
    await settleRootLLMBudget(reservation, actualTokens);
  } catch {
    throw new LLMOperationError(
      "LLM_BUDGET_UNAVAILABLE",
      "LLM budget settlement unavailable",
    );
  }
}

/** 文本补全。 */
export async function complete(opts: {
  model: string;
  policy: RootLLMPolicy;
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reservedTokens = reservationUpperBound(opts.system, opts.user, maxTokens);
  if (opts.signal?.aborted) {
    throw new LLMOperationError("LLM_PROVIDER_REQUEST_FAILED", "LLM provider request failed");
  }
  // Validate and construct the non-I/O provider client before charging the
  // daily ledger. A local configuration error must not strand a reservation.
  const client = getClient();
  let reservation;
  try {
    const result = await reserveRootLLMBudget(opts.policy, randomUUID(), reservedTokens);
    if (!result.allowed) {
      throw new LLMOperationError(
        "LLM_BUDGET_EXHAUSTED",
        "LLM daily budget exhausted",
        result.retryAfter,
      );
    }
    reservation = result;
  } catch (error) {
    if (error instanceof LLMOperationError) throw error;
    throw new LLMOperationError(
      "LLM_BUDGET_UNAVAILABLE",
      "LLM budget reservation unavailable",
    );
  }

  let response;
  try {
    response = await client.chat.completions.create(
      {
        model: opts.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        // DeepSeek JSON 模式：要求 prompt 内含 "json" 字样（本项目 prompt 已满足）。
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch {
    await settleOrFail(reservation, null);
    throw new LLMOperationError(
      "LLM_PROVIDER_REQUEST_FAILED",
      "LLM provider request failed",
    );
  }

  const firstChoice =
    response !== null &&
    typeof response === "object" &&
    Array.isArray(response.choices)
      ? response.choices[0]
      : undefined;
  const content =
    firstChoice !== null && typeof firstChoice === "object"
      ? firstChoice.message?.content
      : undefined;
  if (typeof content !== "string") {
    await settleOrFail(reservation, null);
    throw new LLMOperationError("LLM_PROVIDER_INVALID", "LLM provider response is invalid");
  }

  const usage = response.usage?.total_tokens;
  if (usage === undefined) {
    await settleOrFail(reservation, null);
  } else if (
    !Number.isInteger(usage) ||
    usage < 1 ||
    usage > reservation.reservedTokens
  ) {
    await settleOrFail(reservation, null);
    throw new LLMOperationError("LLM_PROVIDER_INVALID", "LLM provider response is invalid");
  } else {
    await settleOrFail(reservation, usage);
  }
  return content;
}

/** 期望 JSON 对象输出：用 JSON 模式，解析后返回。 */
export async function completeJSON<T>(opts: {
  model: string;
  policy: RootLLMPolicy;
  system: string;
  user: string;
  maxTokens?: number;
  schema?: z.ZodType<T>;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const deadlineMs = opts.deadlineMs ?? STRUCTURED_OUTPUT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    throw new LLMOperationError("LLM_INPUT_TOO_LARGE", "LLM structured output deadline is invalid");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal?.aborted) abort();
  else opts.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, deadlineMs);
  // DeepSeek 偶尔返回非 JSON / 截断 → 重试至多 3 次，避免单次抖动让整条夜跑失败。
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (controller.signal.aborted) {
        throw new LLMOperationError("LLM_PROVIDER_REQUEST_FAILED", "LLM provider request failed");
      }
      const text = await complete({ ...opts, json: true, signal: controller.signal });
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const firstJson = text.search(/(?:\[|\{)/);
      const raw = fenced?.[1] ?? (firstJson >= 0 ? text.slice(firstJson) : "");
      try {
        const parsed: unknown = JSON.parse(raw);
        return opts.schema ? opts.schema.parse(parsed) : (parsed as T);
      } catch {
        /* 重试 */
      }
    }
    throw new LLMOperationError(
      "LLM_PROVIDER_INVALID",
      "LLM provider returned invalid structured output",
    );
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", abort);
  }
}
