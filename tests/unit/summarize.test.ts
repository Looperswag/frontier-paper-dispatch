import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RankedItem } from "../../lib/types.ts";

const mocks = vi.hoisted(() => ({
  completeJSON: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../../lib/llm.ts", () => ({
  MODELS: { summarize: "deepseek-chat" },
  completeJSON: mocks.completeJSON,
}));

import { summarizeAll } from "../../scripts/summarize.ts";

function item(externalId: string): RankedItem {
  return {
    source: "arxiv",
    externalId,
    url: `https://example.com/${externalId}`,
    title: `Paper ${externalId}`,
    authors: ["Author"],
    abstract: "A useful abstract.",
    publishedAt: "2026-07-14T00:00:00.000Z",
    signals: {},
    score: 80,
    rank: 1,
    rationale: "reason",
  };
}

beforeEach(() => {
  mocks.readFile.mockReset().mockResolvedValue("profile");
  mocks.completeJSON.mockReset();
});

describe("summarizeAll", () => {
  test("isolates one failed item and returns explicit degraded metadata", async () => {
    mocks.completeJSON
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({ oneLiner: "可用摘要", summaryMd: "方法与结果", impactMd: "值得试验" });

    const result = await summarizeAll([item("failed"), item("healthy")]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      externalId: "failed",
      degraded: true,
      degradedReason: "llm_summary_failed",
    });
    expect(result[0].summaryMd).toContain("原始摘要");
    expect(result[1]).toMatchObject({
      externalId: "healthy",
      oneLiner: "可用摘要",
      degraded: undefined,
    });
  });

  test("reuses a versioned content/profile cache key within a process", async () => {
    mocks.completeJSON.mockResolvedValue({ oneLiner: "缓存", summaryMd: "summary", impactMd: "impact" });

    await summarizeAll([item("cached")]);
    await summarizeAll([item("cached")]);

    expect(mocks.completeJSON).toHaveBeenCalledTimes(1);
  });
});
