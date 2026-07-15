import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { NormalizedItem } from "../../lib/types.ts";
import { ndcgAtK, precisionAtK } from "../../lib/ranking-metrics.ts";
import { rankTop } from "../../scripts/rank.ts";

vi.mock("../../lib/llm.ts", () => ({
  MODELS: { rank: "offline-disabled" },
  completeJSON: vi.fn(async () => {
    throw new Error("offline fixture must inject its ranker");
  }),
}));

function maxSourceCount(items: readonly NormalizedItem[]): number {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

test("offline fixture exercises bounded recall, injected reranking, and diversity", async () => {
  const fixture = JSON.parse(readFileSync("tests/fixtures/ranking/offline-relevance.json", "utf8")) as {
    now: string;
    items: Array<NormalizedItem & { relevance: number }>;
    distractors: { count: number; publishedAt: string };
    modelOrder: string[];
    expectedPrecisionAt5: number;
    expectedNdcgAt5: number;
  };
  const distractors = Array.from({ length: fixture.distractors.count }, (_, index): NormalizedItem => ({
    source: index % 2 ? "blog" : "github",
    externalId: `irrelevant-${String(index).padStart(3, "0")}`,
    url: `https://example.com/irrelevant-${index}`,
    title: `Irrelevant ${index}`,
    authors: [],
    abstract: "Unrelated material",
    publishedAt: fixture.distractors.publishedAt,
    signals: { category: index % 2 ? "misc" : "tooling", sourceWeight: 0 },
  }));
  const relevance = new Map(fixture.items.map((item) => [item.externalId, item.relevance]));
  const items = fixture.items.map(({ relevance: _relevance, ...item }) => item);
  const ranker = vi.fn(async (request: {
    candidates: readonly { idx: number; externalId: string }[];
    schema: { parse: (value: unknown) => { ranked: Array<{ idx: number; score: number; rationale: string }> } };
  }) => request.schema.parse({
    ranked: fixture.modelOrder.map((externalId, position) => {
      const candidate = request.candidates.find((entry) => entry.externalId === externalId);
      if (!candidate) throw new Error(`fixture candidate was not recalled: ${externalId}`);
      return { idx: candidate.idx, score: 100 - position, rationale: `fixture-${position}` };
    }),
  }));

  const ranked = await rankTop(
    [...items, ...distractors],
    5,
    "",
    new Date(fixture.now),
    ranker,
  );
  const rankedRelevance = ranked.map((item) => relevance.get(item.externalId) ?? 0);

  expect(ranker).toHaveBeenCalledOnce();
  expect(ranker.mock.calls[0][0].candidates).toHaveLength(100);
  expect(ranked).toHaveLength(5);
  expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
  expect(ranked.every((item) => Number.isInteger(item.score))).toBe(true);
  expect(maxSourceCount(ranked)).toBeLessThanOrEqual(3);
  expect(precisionAtK(rankedRelevance.map((value) => value > 0), 5)).toBeGreaterThanOrEqual(fixture.expectedPrecisionAt5);
  expect(ndcgAtK(rankedRelevance, 5)).toBeGreaterThanOrEqual(fixture.expectedNdcgAt5);
});
