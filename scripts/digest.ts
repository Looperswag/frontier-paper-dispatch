import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { SummarizedItem } from "../lib/types.ts";
import { classifyEmailFailure, sendEmail } from "../lib/email.ts";
import {
  claimDigestDeliveries,
  claimDeliveries,
  deliveryDateFromTitle,
  enqueueDigestDeliveries,
  finishDelivery,
  requeueFailedDigestDeliveries,
  retryAt,
} from "../lib/outbox.ts";
import {
  loadFeedbackConfig,
  loadServerChanConfig,
  type FeedbackConfig,
} from "../lib/runtime-config.ts";
import { issueFeedbackToken, verifyFeedbackToken } from "../lib/feedback-token.ts";
import { currentRuntimeEnvironment } from "../lib/runtime-env.ts";
import { sendFailureAlert } from "../lib/alert.ts";
import { HttpRequestError, readBoundedJSONResponse } from "../lib/http.ts";

const SHOW_SIGNALS = ["upvotes", "stars", "category", "publisher"];
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalidStoredDigest(): never {
  throw new Error("Stored digest feedback links have expired or are invalid");
}

/** Rejects stale, legacy, rotated, partial, or remapped stored feedback links. */
export function assertDigestFeedbackLinks(
  date: string,
  itemIds: readonly string[],
  markdown: string,
  feedback: FeedbackConfig,
  now: Date | number = Date.now(),
): void {
  const expectedOrigin = new URL(feedback.webBaseURL).origin;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    itemIds.length < 1 ||
    itemIds.length > 5 ||
    new Set(itemIds).size !== itemIds.length ||
    itemIds.some((itemId) => !CANONICAL_UUID.test(itemId)) ||
    markdown.includes("/api/feedback")
  ) {
    invalidStoredDigest();
  }
  const links = [
    ...markdown.matchAll(/\[(👍 有用|👎 不相关)\]\(([^)\r\n]+)\)/g),
  ];
  const expectedCount = itemIds.length * 2;
  if (
    links.length !== expectedCount ||
    (markdown.match(/[?&]token=/g)?.length ?? 0) !== expectedCount
  ) {
    invalidStoredDigest();
  }

  const expected = itemIds.flatMap((itemId) => [`${itemId}:up`, `${itemId}:down`]);
  const actual: string[] = [];
  for (const [, label, destination] of links) {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      invalidStoredDigest();
    }
    const parameters = [...url.searchParams];
    if (
      url.origin !== expectedOrigin ||
      url.pathname !== "/feedback" ||
      url.hash ||
      url.username ||
      url.password ||
      parameters.length !== 1 ||
      parameters[0][0] !== "token"
    ) {
      invalidStoredDigest();
    }
    const claims = verifyFeedbackToken(feedback.secret, parameters[0][1], now);
    const rating = label === "👍 有用" ? "up" : "down";
    if (!claims || claims.digestDate !== date || claims.rating !== rating) {
      invalidStoredDigest();
    }
    actual.push(`${claims.itemId}:${claims.rating}`);
  }
  if (actual.some((value, index) => value !== expected[index])) invalidStoredDigest();
}

/** 渲染每日简报 markdown（也是写进 digests.rendered_md 的内容）。 */
export function renderDigest(
  date: string,
  items: SummarizedItem[],
  idByKey: Map<string, string>,
): string {
  const feedback = loadFeedbackConfig(currentRuntimeEnvironment());
  const head = `# 前沿论文情报台 · ${date}\n\n> 今日 Top ${items.length}（按对你的价值排序）。登录 Web 情报台后可记录反馈，明天更准。\n\n---\n\n`;
  const body = items
    .map((it) => {
      const itemId = idByKey.get(`${it.source}:${it.externalId}`);
      if (!itemId) throw new Error("Missing digest item mapping");
      const feedbackURL = (rating: "up" | "down") => {
        const url = new URL("/feedback", feedback.webBaseURL);
        url.searchParams.set(
          "token",
          issueFeedbackToken(feedback.secret, { digestDate: date, itemId, rating }),
        );
        return url.toString();
      };
      const sig = Object.entries(it.signals)
        .filter(([k]) => SHOW_SIGNALS.includes(k))
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      return [
        `## ${it.rank}. ${it.title}`,
        ``,
        `- 来源：${it.source}${sig ? ` · ${sig}` : ""} · 评分 ${it.score}`,
        `- 链接：${it.url}`,
        `- 作者：${it.authors.slice(0, 6).join(", ") || "—"}`,
        `- 反馈：[👍 有用](${feedbackURL("up")}) · [👎 不相关](${feedbackURL("down")})（登录后确认）`,
        ``,
        `**一句话看点**　${it.oneLiner}`,
        ``,
        `**概要**`,
        ``,
        it.summaryMd,
        ``,
        `**对你的影响**`,
        ``,
        it.impactMd,
        ``,
        ...(it.degraded ? [`> ⚠️ 本条为降级结果（${it.degradedReason === "llm_rank_failed" ? "排名服务暂不可用" : "摘要服务暂不可用"}），请以原文为准。`, ``] : []),
        `> 入选理由：${it.rationale}`,
        ``,
        `---`,
      ].join("\n");
    })
    .join("\n\n");
  return head + body;
}

/** 推送到微信（Server酱 / ServerChan）。markdown 直接作为 desp，无需 SDK。
 *  自动适配两种 SendKey：老版 Turbo（SCT...）走 ftqq，Server酱³（sctp<uid>t...）走 ft07。 */
function validateServerChanResponse(value: unknown): { code: 0 } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { code?: unknown }).code !== 0
  ) {
    throw new Error("ServerChan response does not contain an explicit success code");
  }
  return { code: 0 };
}

async function sendServerChan(title: string, md: string): Promise<void> {
  const key = loadServerChanConfig(currentRuntimeEnvironment()).sendKey;
  const uid = key.match(/^sctp(\d+)t/)?.[1];
  const url = uid
    ? `https://${uid}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: title.slice(0, 32), desp: md }),
      signal: controller.signal,
    });
    await readBoundedJSONResponse(res, {
      endpoint: "serverchan",
      maxResponseBytes: 64 * 1024,
      signal: controller.signal,
      validate: validateServerChanResponse,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function retryableServerChanFailure(error: unknown): boolean {
  if (error instanceof HttpRequestError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (408|429|5\d\d)|aborted|timed out|network|fetch/i.test(message);
}

export interface DeliveryAttemptReport {
  readonly attempted: number;
  readonly permanentFailures: readonly string[];
  readonly retried: readonly string[];
  readonly succeeded: readonly string[];
}

export interface DeliveryReplayReport extends DeliveryAttemptReport {
  readonly requeued: number;
}

/** Process one leased attempt per claimable channel without re-enqueuing a digest. */
async function processClaimedDeliveries(
  deliveries: Awaited<ReturnType<typeof claimDeliveries>>,
  workerId: string,
): Promise<DeliveryAttemptReport> {
  const permanentFailures: string[] = [];
  const retried: string[] = [];
  const succeeded: string[] = [];
  for (const delivery of deliveries) {
    try {
      let providerMessageId: string | undefined;
      if (delivery.channel === "email") {
        const result = await sendEmail({
          subject: delivery.payload.title,
          text: delivery.payload.markdown,
          idempotencyKey: delivery.idempotencyKey,
        });
        if (!result || typeof result.messageId !== "string" || !result.messageId) {
          throw new Error("SMTP provider returned no delivery receipt");
        }
        providerMessageId = result.messageId;
      } else {
        await sendServerChan(delivery.payload.title, delivery.payload.markdown);
      }
      await finishDelivery(delivery.deliveryId, workerId, "success", { providerMessageId });
      succeeded.push(delivery.channel);
    } catch (error) {
      const retryable = delivery.channel === "email"
        ? classifyEmailFailure(error) === "retryable"
        : retryableServerChanFailure(error);
      const safeReason = delivery.channel === "email" ? "SMTP delivery failed" : "ServerChan delivery failed";
      const outcome = retryable && delivery.attempts < 5 ? "retry" : "permanent";
      await finishDelivery(
        delivery.deliveryId,
        workerId,
        outcome,
        outcome === "retry"
          ? { error: safeReason, nextAttemptAt: retryAt(delivery.attempts) }
          : { error: safeReason },
      );
      (outcome === "retry" ? retried : permanentFailures).push(delivery.channel);
    }
  }
  if (permanentFailures.length) {
    const channels = [...new Set(permanentFailures)].join(", ");
    const correlationId = `delivery:${createHash("sha256")
      .update(deliveries.map((delivery) => delivery.idempotencyKey).sort().join("\0"))
      .digest("hex")}`;
    await sendFailureAlert({
      event: "delivery_failed",
      severity: "critical",
      detail: `channels=${channels}`,
      correlationId,
    });
    throw new Error(`Delivery failed for: ${channels}`);
  }
  return Object.freeze({
    attempted: deliveries.length,
    permanentFailures: Object.freeze([...permanentFailures]),
    retried: Object.freeze([...retried]),
    succeeded: Object.freeze([...succeeded]),
  });
}

export async function processPendingDeliveries(
  workerId = randomUUID(),
): Promise<DeliveryAttemptReport> {
  return processClaimedDeliveries(await claimDeliveries(workerId), workerId);
}

/** Manual recovery path: never claims an unrelated digest's pending delivery. */
export async function processDigestDeliveries(
  digestDate: string,
  workerId = randomUUID(),
): Promise<DeliveryAttemptReport> {
  return processClaimedDeliveries(
    await claimDigestDeliveries(digestDate, workerId),
    workerId,
  );
}

/** Enqueue a digest, then make one immediate leased delivery attempt. */
export async function pushDigest(
  title: string,
  md: string,
  pipelineRunId?: string,
): Promise<DeliveryAttemptReport> {
  if (pipelineRunId) {
    await enqueueDigestDeliveries(title, md, currentRuntimeEnvironment(), pipelineRunId);
  } else {
    await enqueueDigestDeliveries(title, md);
  }
  return processDigestDeliveries(deliveryDateFromTitle(title));
}

/** Explicit manual recovery: revive failed rows for configured channels only. */
export async function replayDigest(
  title: string,
  md: string,
): Promise<DeliveryReplayReport> {
  const digestDate = deliveryDateFromTitle(title);
  await enqueueDigestDeliveries(title, md);
  const requeued = await requeueFailedDigestDeliveries(digestDate);
  const report = await processDigestDeliveries(digestDate);
  return Object.freeze({ ...report, requeued });
}
