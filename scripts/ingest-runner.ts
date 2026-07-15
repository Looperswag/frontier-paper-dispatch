import { randomUUID } from "node:crypto";
import { lockShanghaiRunTime } from "../lib/time.ts";
import { sendFailureAlert } from "../lib/alert.ts";
import { filterFreshItems } from "../lib/source-freshness.ts";
import type { NormalizedItem, RankedItem, SummarizedItem } from "../lib/types.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";
import type { PipelineRunState, PipelineStatus, SourceRunStatus } from "../lib/pipeline-run.ts";
import { hasBoundedSourceIdentity } from "../lib/normalize.ts";
import type { DeliveryAttemptReport } from "./digest.ts";

export class IncompleteCandidatePoolError extends Error {
  constructor(candidateCount: number, minimum: number) {
    super(`Fresh candidate pool is incomplete (${candidateCount}/${minimum})`);
    this.name = "IncompleteCandidatePoolError";
  }
}

export interface FeedbackRecord {
  category: string;
  note: string | null;
  rating: string;
  source: string;
  title: string;
}

export interface IngestDependencies {
  clock: () => Date;
  /** Wall-clock observations for source latency; separate from a catch-up run's logical date. */
  observedClock?: () => Date;
  dedupe: (items: NormalizedItem[]) => NormalizedItem[];
  feedbackSummary: (feedback: FeedbackRecord[]) => string;
  fetchFeedback: () => Promise<FeedbackRecord[]>;
  fetchers: readonly (readonly [name: string, fetch: () => Promise<NormalizedItem[]>])[];
  logger: Pick<Console, "log" | "warn">;
  pushDigest: (
    title: string,
    markdown: string,
    pipelineRunId?: string,
  ) => Promise<DeliveryAttemptReport>;
  rankTop: (items: NormalizedItem[], count: number, feedback: string) => Promise<RankedItem[]>;
  renderDigest: (
    date: string,
    items: SummarizedItem[],
    idByKey: Map<string, string>,
  ) => string;
  saveDigest: (
    date: string,
    items: SummarizedItem[],
    idByKey: Map<string, string>,
    markdown: string,
    pipelineRunId?: string,
  ) => Promise<void>;
  summarizeAll: (
    items: RankedItem[],
    idByKey?: ReadonlyMap<string, string>,
  ) => Promise<SummarizedItem[]>;
  upsertItems: (
    items: NormalizedItem[],
    pipelineOwner?: { runDate: string; runId: string },
  ) => Promise<Map<string, string>>;
  filterRecentlyDelivered?: (items: readonly NormalizedItem[]) => Promise<NormalizedItem[]>;
  pipeline?: {
    start: (runDate: string, runId: string) => Promise<{
      acquired: boolean;
      activeRunId: string;
      status: PipelineRunState;
    }>;
    heartbeat: (runDate: string, runId: string) => Promise<void>;
    recordSource: (input: {
      runId: string;
      source: string;
      status: SourceRunStatus;
      itemCount: number;
      errorMessage?: string | null;
      startedAt: string;
      finishedAt: string;
    }) => Promise<void>;
    finish: (input: {
      runId: string;
      status: PipelineStatus;
      candidateCount: number;
      sourceCount: number;
      errorMessage?: string | null;
    }) => Promise<void>;
  };
}

export interface IngestOptions {
  dry: boolean;
  send: boolean;
  /** Production defaults to five; tests and explicit backfills may lower it. */
  minCandidates?: number;
}

const naiveScore = (item: NormalizedItem): number =>
  Number(item.signals.upvotes ?? 0) + Number(item.signals.stars ?? 0) / 50;

function rejectionMessage(reason: unknown): string {
  if (reason instanceof Error) return safeErrorMessage(reason);
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (message !== undefined && message !== null) {
      return safeErrorMessage(new Error(String(message)));
    }
  }
  return safeErrorMessage(reason);
}

interface SourceResult {
  source: string;
  status: SourceRunStatus;
  itemCount: number;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
}

async function collect(
  dependencies: IngestDependencies,
  now: Date,
): Promise<{ items: NormalizedItem[]; sources: SourceResult[] }> {
  const observedClock = dependencies.observedClock ?? (() => new Date());
  const sourceRuns = dependencies.fetchers.map(async ([name, fetchItems]) => {
    const startedAt = observedClock().toISOString();
    try {
      const value = await fetchItems();
      return { name, result: { status: "fulfilled" as const, value }, startedAt, finishedAt: observedClock().toISOString() };
    } catch (reason) {
      return { name, result: { status: "rejected" as const, reason }, startedAt, finishedAt: observedClock().toISOString() };
    }
  });
  const results = await Promise.allSettled(
    sourceRuns,
  );
  const items: NormalizedItem[] = [];
  const sources: SourceResult[] = [];
  results.forEach((result, index) => {
    const fallbackName = dependencies.fetchers[index][0];
    if (result.status === "rejected") {
      const errorMessage = rejectionMessage(result.reason);
      dependencies.logger.warn(`[${fallbackName}] 失败：${errorMessage}`);
      const observedAt = observedClock().toISOString();
      sources.push({
        source: fallbackName,
        status: "failed",
        itemCount: 0,
        errorMessage,
        startedAt: observedAt,
        finishedAt: observedAt,
      });
      return;
    }
    const { name, result: fetchResult, startedAt, finishedAt } = result.value;
    if (fetchResult.status === "fulfilled") {
      const bounded = fetchResult.value.filter((item) => {
        if (hasBoundedSourceIdentity(item)) return true;
        const identifier = (item.externalId || item.title || "unknown").slice(0, 80);
        dependencies.logger.warn(`[${name}] 丢弃 ${identifier}：源身份超出安全边界`);
        return false;
      });
      const fresh = filterFreshItems(bounded, now, (item, reason) => {
        dependencies.logger.warn(`[${name}] 丢弃 ${item.externalId || item.title || "unknown"}：时间${reason}`);
      });
      dependencies.logger.log(`[${name}] ${fresh.length}/${fetchResult.value.length} 条通过新鲜度门禁`);
      items.push(...fresh);
      sources.push({
        source: name,
        status: fresh.length ? "succeeded" : "empty",
        itemCount: fresh.length,
        startedAt,
        finishedAt,
      });
      return;
    }
    const errorMessage = rejectionMessage(fetchResult.reason);
    dependencies.logger.warn(`[${name}] 失败：${errorMessage}`);
    sources.push({ source: name, status: "failed", itemCount: 0, errorMessage, startedAt, finishedAt });
  });
  return { items: dependencies.dedupe(items), sources };
}

export async function runIngest(
  options: IngestOptions,
  dependencies: IngestDependencies,
): Promise<void> {
  const runTime = lockShanghaiRunTime(dependencies.clock);
  dependencies.logger.log(
    `\n=== 采集开始（${runTime.date}）${options.dry ? " [dry]" : ""} ===`,
  );

  let pipelineRunId: string | undefined;
  if (!options.dry && dependencies.pipeline) {
    const runId = randomUUID();
    const started = await dependencies.pipeline.start(runTime.date, runId);
    if (!started.acquired) {
      dependencies.logger.warn(`本日已有运行（${started.activeRunId}，${started.status}），跳过重复执行。`);
      if (started.status === "succeeded") return;
      throw new Error(`Pipeline lease is still running (${started.activeRunId})`);
    }
    pipelineRunId = started.activeRunId;
  }

  let collected: { items: NormalizedItem[]; sources: SourceResult[] } = { items: [], sources: [] };
  let items: NormalizedItem[] = [];
  let sourceLedgerFailureCount = 0;
  let pipelineFinalized = false;
  try {
    collected = await collect(dependencies, new Date(runTime.startedAt));
    items = collected.items;
    dependencies.logger.log(`去重后候选：${items.length} 条`);

    if (options.dry) {
      const preview = [...items].sort((a, b) => naiveScore(b) - naiveScore(a)).slice(0, 15);
      dependencies.logger.log("\n按朴素信号预览前 15：");
      for (const item of preview) {
        dependencies.logger.log(
          `  · [${item.source}] (${naiveScore(item).toFixed(1)}) ${item.title.slice(0, 80)}`,
        );
      }
      dependencies.logger.log(
        "\n[dry] 未写库、未排名、未发信。配好 .env 后用 `npm run ingest` / `npm run ingest:send`。",
      );
      return;
    }

    if (dependencies.filterRecentlyDelivered) {
      items = await dependencies.filterRecentlyDelivered(items);
      if (items.length !== collected.items.length) {
        dependencies.logger.log(`排除近期已推送内容：${collected.items.length - items.length} 条`);
      }
    }
    if (pipelineRunId && dependencies.pipeline) {
      await dependencies.pipeline.heartbeat(runTime.date, pipelineRunId);
      await Promise.all(
        collected.sources.map(async (source) => {
          try {
            await dependencies.pipeline!.recordSource({ ...source, runId: pipelineRunId! });
          } catch (error) {
            sourceLedgerFailureCount += 1;
            dependencies.logger.warn(`运行来源账本写入失败：${rejectionMessage(error)}`);
          }
        }),
      );
    }

    const minCandidates = options.minCandidates ?? 5;
    if (!Number.isInteger(minCandidates) || minCandidates < 1 || minCandidates > 500) {
      throw new Error("Invalid minimum candidate threshold");
    }
    if (items.length < minCandidates) {
      dependencies.logger.warn(
        `候选不足（${items.length}/${minCandidates}），本次跳过写库、排名、摘要和投递；保留已有日报。`,
      );
      if (pipelineRunId && dependencies.pipeline) {
        await dependencies.pipeline.finish({
          runId: pipelineRunId,
          status: "skipped",
          candidateCount: items.length,
          sourceCount: collected.sources.length,
          errorMessage: [
            `candidate_count_below_${minCandidates}`,
            sourceLedgerFailureCount > 0
              ? `source_ledger_write_failed=${sourceLedgerFailureCount}`
              : undefined,
          ].filter(Boolean).join(";"),
        });
        pipelineFinalized = true;
      }
      await sendFailureAlert({
        event: "candidate_pool_below_threshold",
        severity: "warning",
        runDate: runTime.date,
        detail: `candidate_count=${items.length};minimum=${minCandidates}`,
        correlationId: pipelineRunId,
      });
      throw new IncompleteCandidatePoolError(items.length, minCandidates);
    }

    const idByKey = pipelineRunId
      ? await dependencies.upsertItems(items, {
          runDate: runTime.date,
          runId: pipelineRunId,
        })
      : await dependencies.upsertItems(items);
    dependencies.logger.log(`已写入 Supabase：${idByKey.size} 条`);

    const feedback = dependencies.feedbackSummary(await dependencies.fetchFeedback());
    if (feedback) dependencies.logger.log("已加载近期反馈用于排名（内容不写入本地日志）");
    const ranked = await dependencies.rankTop(items, 5, feedback);
    dependencies.logger.log(
      `排名 Top5：\n${ranked
        .map((item) => `  ${item.rank}. (${item.score}) ${item.title.slice(0, 50)}`)
        .join("\n")}`,
    );

    const summarized = await dependencies.summarizeAll(ranked, idByKey);
    const markdown = dependencies.renderDigest(runTime.date, summarized, idByKey);
    if (pipelineRunId) {
      await dependencies.saveDigest(runTime.date, summarized, idByKey, markdown, pipelineRunId);
    } else {
      await dependencies.saveDigest(runTime.date, summarized, idByKey, markdown);
    }

    if (options.send) {
      const title = `前沿论文情报台 · ${runTime.date} · Top5`;
      const delivery = pipelineRunId
        ? await dependencies.pushDigest(title, markdown, pipelineRunId)
        : await dependencies.pushDigest(title, markdown);
      if (delivery.succeeded.length) {
        dependencies.logger.log(`本轮实际投递成功：${delivery.succeeded.join(",")} ✉️`);
      }
      if (delivery.retried.length) {
        dependencies.logger.warn(`暂未送达，已进入 outbox 重试：${delivery.retried.join(",")}`);
      }
      if (!delivery.attempted) {
        dependencies.logger.warn("日报已入队；本轮未取得投递租约，将由 delivery worker 继续处理。");
      }
    } else {
      dependencies.logger.log("（未加 --send，已写库未推送）");
    }
    if (pipelineRunId && dependencies.pipeline) {
      const sourceFetchFailed = collected.sources.some((source) => source.status === "failed");
      const degraded = sourceFetchFailed || sourceLedgerFailureCount > 0;
      await dependencies.pipeline.finish({
        runId: pipelineRunId,
        status: degraded ? "degraded" : "succeeded",
        candidateCount: items.length,
        sourceCount: collected.sources.length,
        ...(sourceLedgerFailureCount > 0
          ? { errorMessage: `source_ledger_write_failed=${sourceLedgerFailureCount}` }
          : sourceFetchFailed
            ? { errorMessage: "source_fetch_failed" }
            : {}),
      });
      if (sourceLedgerFailureCount > 0) {
        await sendFailureAlert({
          event: "source_ledger_degraded",
          severity: "warning",
          runDate: runTime.date,
          detail: `failed_writes=${sourceLedgerFailureCount}`,
          correlationId: pipelineRunId,
        });
      }
    }
    dependencies.logger.log("\n=== 完成 ===");
  } catch (error) {
    if (pipelineRunId && dependencies.pipeline && !pipelineFinalized) {
      await dependencies.pipeline.finish({
        runId: pipelineRunId,
        status: "failed",
        candidateCount: items.length,
        sourceCount: collected.sources.length,
        errorMessage: rejectionMessage(error),
      }).catch((finishError) => dependencies.logger.warn(`运行账本写入失败：${rejectionMessage(finishError)}`));
    }
    if (!options.dry && !(error instanceof IncompleteCandidatePoolError)) {
      await sendFailureAlert({
        event: "pipeline_failed",
        severity: "critical",
        runDate: runTime.date,
        detail: rejectionMessage(error),
        correlationId: pipelineRunId,
      });
    }
    throw error;
  }
}
