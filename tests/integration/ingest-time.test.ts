import { expect, test, vi } from "vitest";
import type { NormalizedItem, RankedItem, SummarizedItem } from "../../lib/types.ts";
import { resolveIngestRunInstant } from "../../scripts/ingest.ts";
import { runIngest, type IngestDependencies } from "../../scripts/ingest-runner.ts";

const item: NormalizedItem = {
  abstract: "abstract",
  authors: ["author"],
  externalId: "paper-1",
  publishedAt: "2026-07-09T00:00:00.000Z",
  signals: {},
  source: "arxiv",
  title: "Paper",
  url: "https://example.com/paper",
};

const ranked: RankedItem = { ...item, rank: 1, rationale: "useful", score: 99 };
const summarized: SummarizedItem = {
  ...ranked,
  impactMd: "impact",
  oneLiner: "one line",
  summaryMd: "summary",
};

test("binds a catch-up run to the missed Shanghai schedule date", () => {
  const instant = resolveIngestRunInstant(
    ["node", "ingest", "--send", "--scheduled-date", "2026-07-14"],
    new Date("2026-07-15T00:00:00.000Z"),
  );

  expect(instant.toISOString()).toBe("2026-07-14T14:00:00.000Z");
});

test.each([
  ["future schedule", "2026-07-15", "2026-07-15T00:00:00.000Z"],
  ["invalid calendar date", "2026-02-30", "2026-03-01T00:00:00.000Z"],
  ["stale schedule", "2026-07-12", "2026-07-15T00:00:00.000Z"],
])("rejects a %s override", (_label, date, now) => {
  expect(() => resolveIngestRunInstant(
    ["node", "ingest", "--send", "--scheduled-date", date],
    new Date(now),
  )).toThrow("Invalid scheduled ingest date");
});

test("one ingest run keeps its locked Shanghai date across midnight", async () => {
  const clock = vi
    .fn<() => Date>()
    .mockReturnValueOnce(new Date("2026-07-09T15:59:59.999Z"))
    .mockReturnValue(new Date("2026-07-09T16:00:00.000Z"));
  const log = vi.fn();
  const renderDigest = vi.fn(() => "rendered digest");
  const saveDigest = vi.fn();
  const pushDigest = vi.fn(async () => ({
    attempted: 1,
    permanentFailures: [],
    retried: [],
    succeeded: ["wechat"],
  }));
  const idByKey = new Map([["arxiv:paper-1", "database-id"]]);

  const dependencies: IngestDependencies = {
    clock,
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log, warn: vi.fn() },
    pushDigest,
    rankTop: async () => [ranked],
    renderDigest,
    saveDigest,
    summarizeAll: async () => [summarized],
    upsertItems: async () => idByKey,
  };

  await runIngest({ dry: false, send: true, minCandidates: 1 }, dependencies);

  expect(clock).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat().join("\n")).toContain("2026-07-09");
  expect(log.mock.calls.flat().join("\n")).not.toContain("2026-07-10");
  expect(renderDigest).toHaveBeenCalledWith("2026-07-09", [summarized], idByKey);
  expect(saveDigest).toHaveBeenCalledWith("2026-07-09", [summarized], idByKey, "rendered digest");
  expect(pushDigest).toHaveBeenCalledWith("前沿论文情报台 · 2026-07-09 · Top5", "rendered digest");
  expect(log).toHaveBeenCalledWith("本轮实际投递成功：wechat ✉️");
});

test("uses private feedback for ranking without copying it into local logs", async () => {
  const sensitiveFeedback = "Private Paper：down（内部客户理由）";
  const log = vi.fn();
  const rankTop = vi.fn(async () => [ranked]);

  await runIngest({ dry: false, send: false, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => sensitiveFeedback,
    fetchFeedback: async () => [{
      category: "arxiv",
      note: "内部客户理由",
      rating: "down",
      source: "arxiv",
      title: "Private Paper",
    }],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log, warn: vi.fn() },
    pushDigest: vi.fn(),
    rankTop,
    renderDigest: () => "rendered",
    saveDigest: vi.fn(),
    summarizeAll: async () => [summarized],
    upsertItems: async () => new Map([["arxiv:paper-1", "database-id"]]),
  });

  expect(rankTop).toHaveBeenCalledWith([item], 5, sensitiveFeedback);
  expect(log.mock.calls.flat().join("\n")).not.toContain(sensitiveFeedback);
  expect(log.mock.calls.flat().join("\n")).toContain("已加载近期反馈用于排名");
});

test("preserves a provider rejection object's diagnostic message", async () => {
  const warn = vi.fn();
  const unused = vi.fn();
  const dependencies: IngestDependencies = {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: unused,
    fetchers: [["blog", async () => Promise.reject({ message: "限流" })]],
    logger: { log: vi.fn(), warn },
    pushDigest: unused,
    rankTop: unused,
    renderDigest: unused,
    saveDigest: unused,
    summarizeAll: unused,
    upsertItems: unused,
  };

  await runIngest({ dry: true, send: false }, dependencies);

  expect(warn).toHaveBeenCalledWith("[blog] 失败：限流");
});

test("does not overwrite or deliver when the fresh candidate pool is too small", async () => {
  const calls = {
    rank: vi.fn(),
    summarize: vi.fn(),
    save: vi.fn(),
    push: vi.fn(),
    upsert: vi.fn(),
  };
  await expect(runIngest({ dry: false, send: true, minCandidates: 2 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pushDigest: calls.push,
    rankTop: calls.rank,
    renderDigest: vi.fn(),
    saveDigest: calls.save,
    summarizeAll: calls.summarize,
    upsertItems: calls.upsert,
  })).rejects.toThrow("candidate pool is incomplete");
  expect(calls.upsert).not.toHaveBeenCalled();
  expect(calls.rank).not.toHaveBeenCalled();
  expect(calls.summarize).not.toHaveBeenCalled();
  expect(calls.save).not.toHaveBeenCalled();
  expect(calls.push).not.toHaveBeenCalled();
});

test("closes a leased shortage once as skipped and leaves it retryable", async () => {
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
  const upsertItems = vi.fn();

  await expect(runIngest({ dry: false, send: true, minCandidates: 2 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems,
  })).rejects.toThrow("candidate pool is incomplete");

  expect(pipeline.finish).toHaveBeenCalledOnce();
  expect(pipeline.finish).toHaveBeenCalledWith({
    runId: "77777777-7777-4777-8777-777777777777",
    status: "skipped",
    candidateCount: 1,
    sourceCount: 1,
    errorMessage: "candidate_count_below_2",
  });
  expect(upsertItems).not.toHaveBeenCalled();
});

test("records a durable run lease, source health, and completion status", async () => {
  const saveDigest = vi.fn(async () => undefined);
  const upsertItems = vi.fn(async () => new Map([["arxiv:paper-1", "database-id"]]));
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
  await runIngest({ dry: false, send: false, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: async () => [ranked],
    renderDigest: () => "rendered",
    saveDigest,
    summarizeAll: async () => [summarized],
    upsertItems,
  });
  expect(pipeline.start).toHaveBeenCalledWith("2026-07-09", expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(pipeline.recordSource).toHaveBeenCalledWith(expect.objectContaining({
    runId: "77777777-7777-4777-8777-777777777777",
    source: "arxiv",
    status: "succeeded",
    itemCount: 1,
  }));
  expect(pipeline.heartbeat).toHaveBeenNthCalledWith(
    1,
    "2026-07-09",
    "77777777-7777-4777-8777-777777777777",
  );
  expect(pipeline.heartbeat).toHaveBeenCalledTimes(1);
  expect(saveDigest).toHaveBeenCalledWith(
    "2026-07-09",
    [summarized],
    expect.any(Map),
    "rendered",
    "77777777-7777-4777-8777-777777777777",
  );
  expect(upsertItems).toHaveBeenCalledWith([item], {
    runDate: "2026-07-09",
    runId: "77777777-7777-4777-8777-777777777777",
  });
  expect(pipeline.finish).toHaveBeenCalledWith({
    runId: "77777777-7777-4777-8777-777777777777",
    status: "succeeded",
    candidateCount: 1,
    sourceCount: 1,
  });
});

test("fails retryably when another run still owns today's pipeline lease", async () => {
  const fetchItems = vi.fn(async () => [item]);
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: false,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };

  await expect(runIngest({ dry: false, send: false }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", fetchItems]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: vi.fn(),
  })).rejects.toThrow("still running");
  expect(fetchItems).not.toHaveBeenCalled();
  expect(pipeline.finish).not.toHaveBeenCalled();
});

test("treats an already succeeded date as an idempotent success", async () => {
  const fetchItems = vi.fn(async () => [item]);
  await expect(runIngest({ dry: false, send: false }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", fetchItems]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline: {
      start: vi.fn(async () => ({
        acquired: false,
        activeRunId: "77777777-7777-4777-8777-777777777777",
        status: "succeeded",
      })),
      heartbeat: vi.fn(async () => undefined),
      recordSource: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    },
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: vi.fn(),
  })).resolves.toBeUndefined();
  expect(fetchItems).not.toHaveBeenCalled();
});

test("marks a completed run degraded when its source ledger cannot be written", async () => {
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => { throw new Error("ledger unavailable"); }),
    finish: vi.fn(async () => undefined),
  };
  await runIngest({ dry: false, send: false, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: async () => [ranked],
    renderDigest: () => "rendered",
    saveDigest: async () => undefined,
    summarizeAll: async () => [summarized],
    upsertItems: async () => new Map([["arxiv:paper-1", "database-id"]]),
  });

  expect(pipeline.finish).toHaveBeenCalledWith(expect.objectContaining({
    errorMessage: "source_ledger_write_failed=1",
    status: "degraded",
  }));
});

test("records observed source timing instead of the scheduled catch-up instant", async () => {
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
  const observedClock = vi.fn<() => Date>()
    .mockReturnValueOnce(new Date("2026-07-09T01:00:00.000Z"))
    .mockReturnValueOnce(new Date("2026-07-09T01:00:03.000Z"));
  await runIngest({ dry: false, send: false, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    observedClock,
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: async () => [ranked],
    renderDigest: () => "rendered",
    saveDigest: async () => undefined,
    summarizeAll: async () => [summarized],
    upsertItems: async () => new Map([["arxiv:paper-1", "database-id"]]),
  });

  expect(pipeline.recordSource).toHaveBeenCalledWith(expect.objectContaining({
    startedAt: "2026-07-09T01:00:00.000Z",
    finishedAt: "2026-07-09T01:00:03.000Z",
  }));
});

test("excludes recently delivered candidates before the minimum-pool guard", async () => {
  const calls = { filter: vi.fn(async (items: readonly NormalizedItem[]) => items.slice(1)), upsert: vi.fn() };
  await expect(runIngest({ dry: false, send: false, minCandidates: 2 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item, { ...item, externalId: "paper-2" }]]],
    filterRecentlyDelivered: calls.filter,
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline: undefined,
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: calls.upsert,
  })).rejects.toThrow("candidate pool is incomplete");
  expect(calls.filter).toHaveBeenCalledOnce();
  expect(calls.upsert).not.toHaveBeenCalled();
});

test("dry mode never queries delivery history", async () => {
  const filter = vi.fn(async () => { throw new Error("database unavailable"); });
  await expect(runIngest({ dry: true, send: false }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    filterRecentlyDelivered: filter,
    logger: { log: vi.fn(), warn: vi.fn() },
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: vi.fn(),
  })).resolves.toBeUndefined();
  expect(filter).not.toHaveBeenCalled();
});

test("drops and reports an invalid source identity before a bulk database write", async () => {
  const warn = vi.fn();
  const invalid = { ...item, externalId: "x".repeat(513), title: "Oversized identity" };
  await runIngest({ dry: true, send: false }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [invalid, item]]],
    logger: { log: vi.fn(), warn },
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: vi.fn(),
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("源身份超出安全边界"));
});

test("novelty query failure closes the acquired pipeline lease", async () => {
  const pipeline = {
    start: vi.fn(async () => ({ acquired: true, activeRunId: "77777777-7777-4777-8777-777777777777", status: "running" })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  };
  await expect(runIngest({ dry: false, send: false }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    filterRecentlyDelivered: async () => { throw new Error("database unavailable"); },
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: vi.fn(),
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: vi.fn(),
    summarizeAll: vi.fn(),
    upsertItems: vi.fn(),
  })).rejects.toThrow("database unavailable");
  expect(pipeline.finish).toHaveBeenCalledWith(expect.objectContaining({
    runId: "77777777-7777-4777-8777-777777777777",
    status: "failed",
  }));
});

test("a fenced worker stops before item, digest, or delivery side effects", async () => {
  const writes = {
    push: vi.fn(),
    save: vi.fn(),
    upsert: vi.fn(),
  };
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running",
    })),
    heartbeat: vi.fn(async () => { throw new Error("pipeline run is not active"); }),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => { throw new Error("pipeline run is not active"); }),
  };

  await expect(runIngest({ dry: false, send: true, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: writes.push,
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: writes.save,
    summarizeAll: vi.fn(),
    upsertItems: writes.upsert,
  })).rejects.toThrow("pipeline run is not active");

  expect(pipeline.recordSource).not.toHaveBeenCalled();
  expect(writes.upsert).not.toHaveBeenCalled();
  expect(writes.save).not.toHaveBeenCalled();
  expect(writes.push).not.toHaveBeenCalled();
});

test("an atomic item upsert rejects takeover after an earlier heartbeat", async () => {
  const writes = { push: vi.fn(), save: vi.fn() };
  const pipeline = {
    start: vi.fn(async () => ({
      acquired: true,
      activeRunId: "77777777-7777-4777-8777-777777777777",
      status: "running" as const,
    })),
    heartbeat: vi.fn(async () => undefined),
    recordSource: vi.fn(async () => undefined),
    finish: vi.fn(async () => { throw new Error("pipeline run is not active"); }),
  };
  const upsertItems = vi.fn(async (
    _items: NormalizedItem[],
    owner?: { runDate: string; runId: string },
  ) => {
    expect(owner).toEqual({
      runDate: "2026-07-09",
      runId: "77777777-7777-4777-8777-777777777777",
    });
    throw new Error("pipeline run is not active");
  });

  await expect(runIngest({ dry: false, send: true, minCandidates: 1 }, {
    clock: () => new Date("2026-07-09T00:00:00.000Z"),
    dedupe: (items) => items,
    feedbackSummary: () => "",
    fetchFeedback: async () => [],
    fetchers: [["arxiv", async () => [item]]],
    logger: { log: vi.fn(), warn: vi.fn() },
    pipeline,
    pushDigest: writes.push,
    rankTop: vi.fn(),
    renderDigest: vi.fn(),
    saveDigest: writes.save,
    summarizeAll: vi.fn(),
    upsertItems,
  })).rejects.toThrow("pipeline run is not active");

  expect(pipeline.heartbeat).toHaveBeenCalledOnce();
  expect(upsertItems).toHaveBeenCalledOnce();
  expect(writes.save).not.toHaveBeenCalled();
  expect(writes.push).not.toHaveBeenCalled();
});
