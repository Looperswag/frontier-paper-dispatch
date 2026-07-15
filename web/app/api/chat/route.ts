import { randomUUID } from "node:crypto";
import { getPaper, getChats, saveChat } from "@/lib/data";
import { deepseek, CHAT_MODEL } from "@/lib/llm";
import { authorizeAPI } from "@/lib/auth-boundary";
import { exactQuery, hasSameMutationOrigin, readBoundedJSON } from "@/lib/api-request";
import {
  apiError,
  apiJSON,
  apiLLMBudgetExhausted,
  apiRateLimited,
  hardenAPIResponse,
} from "@/lib/api-response";
import { chatHistoryQuerySchema, chatMutationSchema } from "@/lib/api-schemas";
import {
  consumeAPIRateLimit,
  reserveLLMBudget,
  settleLLMBudget,
  type LLMBudgetReservation,
} from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHAT_MAX_OUTPUT_TOKENS = 1_500;
const MAX_LLM_RESERVATION_TOKENS = 65_536;
const PROMPT_FRAMING_RESERVE = 4_096;
const MESSAGE_FRAMING_RESERVE = 128;
const CHAT_STREAM_DEADLINE_MS = 60_000;
const MAX_CHAT_RESPONSE_BYTES = 256 * 1024;
const encoder = new TextEncoder();

type ChatPromptMessage = Readonly<{
  content: string;
  role: "assistant" | "system" | "user";
}>;

function chatReservationTokens(messages: readonly ChatPromptMessage[]): number | undefined {
  let contentBytes = 0;
  for (const message of messages) {
    contentBytes += encoder.encode(message.content).byteLength;
    if (contentBytes > MAX_LLM_RESERVATION_TOKENS) return undefined;
  }
  const upperBound =
    contentBytes +
    PROMPT_FRAMING_RESERVE +
    messages.length * MESSAGE_FRAMING_RESERVE +
    CHAT_MAX_OUTPUT_TOKENS;
  return upperBound <= MAX_LLM_RESERVATION_TOKENS ? upperBound : undefined;
}

function databaseFailure(error: unknown): Response {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "DB_NOT_FOUND") return apiError(404, "NOT_FOUND");
  if (code === "DB_OPERATION_FAILED") return apiError(503, "SERVICE_UNAVAILABLE");
  return apiError(500, "INTERNAL_ERROR");
}

function requestFailure(reason: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
  if (reason === "PAYLOAD_TOO_LARGE") return apiError(413, reason);
  if (reason === "UNSUPPORTED_MEDIA_TYPE") return apiError(415, reason);
  return apiError(400, reason);
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new Error("chat provider deadline exceeded");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("chat provider deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// 历史对话
export async function GET(req: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  const parsed = chatHistoryQuerySchema.safeParse(exactQuery(req, ["itemId"]));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");
  try {
    return apiJSON({ chats: await getChats(authorization.owner, parsed.data.itemId) });
  } catch (error) {
    return databaseFailure(error);
  }
}

// 基于本篇论文的满上下文问答，流式返回纯文本；两端落库到 chats。
export async function POST(req: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  if (!hasSameMutationOrigin(req)) return apiError(403, "CROSS_ORIGIN_REQUEST");
  try {
    const decision = await consumeAPIRateLimit(req, "web_chat", authorization.owner);
    if (!decision.allowed) return apiRateLimited(decision.retryAfter);
  } catch {
    return apiError(503, "SERVICE_UNAVAILABLE");
  }
  const body = await readBoundedJSON(req, { maxBytes: 8_192 });
  if (!body.ok) return requestFailure(body.reason);
  const parsed = chatMutationSchema.safeParse(body.value);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");
  const { itemId, message } = parsed.data;

  let paper;
  let prior;
  try {
    paper = await getPaper(authorization.owner, itemId);
    if (!paper) return apiError(404, "NOT_FOUND");

    // 历史从库里读，不信任客户端传入（防伪造/越权）。
    prior = await getChats(authorization.owner, itemId);
  } catch (error) {
    return databaseFailure(error);
  }

  const ctx = [
    `标题：${paper.title}`,
    `来源：${paper.source} · ${paper.url}`,
    paper.authors?.length ? `作者：${paper.authors.join(", ")}` : "",
    `\n摘要：\n${paper.abstract}`,
    paper.summary?.summary_md ? `\n概要：\n${paper.summary.summary_md}` : "",
    paper.summary?.impact_md ? `\n对用户的影响：\n${paper.summary.impact_md}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    `你是嵌在「前沿论文情报台」阅读器里的助手。用户正在读下面这篇论文/项目，` +
    `请主要基于这份资料并结合你的知识回答；资料未覆盖的内容要说明属推测。务实、简洁、中文为主、专有名词保留英文。\n\n=== 资料 ===\n${ctx}`;

  const messages: ChatPromptMessage[] = [
    { role: "system", content: system },
    ...prior.slice(-8).map((history) => ({
      role: history.role,
      content: history.content,
    })),
    { role: "user", content: message },
  ];
  const reservedTokens = chatReservationTokens(messages);
  if (reservedTokens === undefined) return apiError(503, "SERVICE_UNAVAILABLE");

  let reservation: LLMBudgetReservation;
  try {
    const budget = await reserveLLMBudget(
      req,
      authorization.owner,
      randomUUID(),
      reservedTokens,
    );
    if (!budget.allowed) return apiLLMBudgetExhausted(budget.retryAfter);
    reservation = Object.freeze({
      budgetDate: budget.budgetDate,
      reservationId: budget.reservationId,
      reservedTokens: budget.reservedTokens,
    });
  } catch {
    return apiError(503, "SERVICE_UNAVAILABLE");
  }

  try {
    await saveChat(authorization.owner, itemId, "user", message);
  } catch (error) {
    // No provider call has started. Close the reservation so a persistence
    // outage cannot strand the full upper bound in the daily ledger.
    try {
      await settleLLMBudget(authorization.owner, reservation, null);
    } catch {
      // Keep the original database failure as the user-visible result.
    }
    return databaseFailure(error);
  }

  const providerController = new AbortController();
  const abortProvider = () => providerController.abort();
  req.signal.addEventListener("abort", abortProvider, { once: true });
  const providerDeadline = setTimeout(abortProvider, CHAT_STREAM_DEADLINE_MS);
  let completion;
  try {
    completion = await deepseek(authorization.owner).chat.completions.create({
      model: CHAT_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: CHAT_MAX_OUTPUT_TOKENS,
      messages,
    }, { signal: providerController.signal });
  } catch {
    clearTimeout(providerDeadline);
    req.signal.removeEventListener("abort", abortProvider);
    try {
      await settleLLMBudget(authorization.owner, reservation, null);
    } catch {
      // The reservation remains conservative when settlement is unavailable.
    }
    return apiError(502, "UPSTREAM_UNAVAILABLE");
  }

  let full = "";
  let outputBytes = 0;
  let finishReason: string | undefined;
  let settlementAttempted = false;
  const settle = async (actualTokens: number | null): Promise<void> => {
    if (settlementAttempted) throw new Error("duplicate budget settlement");
    settlementAttempted = true;
    await settleLLMBudget(authorization.owner, reservation, actualTokens);
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let totalTokens: number | undefined;
        const iterator = completion[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await nextWithAbort(iterator, providerController.signal);
          if (next.done) break;
          const part = next.value;
          const choice = part.choices[0];
          if (choice && finishReason !== undefined) {
            throw new Error("choice received after finish reason");
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice?.delta?.content ?? "";
          if (delta) {
            outputBytes += encoder.encode(delta).byteLength;
            if (outputBytes > MAX_CHAT_RESPONSE_BYTES) {
              throw new Error("chat response too large");
            }
            full += delta;
            controller.enqueue(encoder.encode(delta));
          }
          if (part.usage !== null && part.usage !== undefined) {
            if (
              totalTokens !== undefined ||
              !Number.isSafeInteger(part.usage.total_tokens) ||
              part.usage.total_tokens < 1 ||
              part.usage.total_tokens > reservation.reservedTokens
            ) {
              throw new Error("invalid completion usage");
            }
            totalTokens = part.usage.total_tokens;
          }
        }
        if (finishReason !== "stop" || !full.trim() || totalTokens === undefined) {
          throw new Error("incomplete completion");
        }
        await settle(totalTokens);
        await saveChat(authorization.owner, itemId, "assistant", full);
        controller.close();
      } catch {
        if (!settlementAttempted) {
          try {
            await settle(null);
          } catch {
            // The pending reservation continues to count against the hard cap.
          }
        }
        try {
          controller.error(new Error("chat stream failed"));
        } catch {
          // The client may already have cancelled the response stream.
        }
      } finally {
        clearTimeout(providerDeadline);
        req.signal.removeEventListener("abort", abortProvider);
        try {
          await iterator.return?.();
        } catch {
          // Best-effort cancellation of an uncooperative provider iterator.
        }
      }
    },
    cancel() {
      providerController.abort();
    },
  });

  return hardenAPIResponse(
    new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}
