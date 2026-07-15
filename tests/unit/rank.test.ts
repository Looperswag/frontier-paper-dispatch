import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NormalizedItem } from "../../lib/types.ts";

const mocks = vi.hoisted(() => ({
  completeJSON: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../../lib/llm.ts", () => ({
  MODELS: { rank: "deepseek-chat" },
  completeJSON: mocks.completeJSON,
}));

import { diversifyRanked, rankTop } from "../../scripts/rank.ts";

const items: NormalizedItem[] = [
  { source: "arxiv", externalId: "a", url: "https://example.com/a", title: "A", authors: [], abstract: "A", publishedAt: "2026-07-14T00:00:00.000Z", signals: { sourceWeight: 1, upvotes: 1 } },
  { source: "github", externalId: "b", url: "https://example.com/b", title: "B", authors: [], abstract: "B", publishedAt: "2026-07-14T00:00:00.000Z", signals: { sourceWeight: 3, stars: 100 } },
  { source: "blog", externalId: "c", url: "https://example.com/c", title: "C", authors: [], abstract: "C", publishedAt: "2026-07-14T00:00:00.000Z", signals: {} },
];

function maxCount<T>(values: readonly T[], keyOf: (value: T) => string): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(keyOf(value), (counts.get(keyOf(value)) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

beforeEach(() => {
  mocks.readFile.mockReset().mockResolvedValue("profile");
  mocks.completeJSON.mockReset();
});

describe("rankTop", () => {
  test("rejects duplicate or out-of-range model indexes and uses a deterministic fallback", async () => {
    mocks.completeJSON.mockRejectedValue(new Error("invalid structured output"));
    const clock = new Date("2026-07-15T00:00:00.000Z");
    const result = await rankTop(items, 2, "", clock);
    const repeated = await rankTop(items, 2, "", clock);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.externalId)).toEqual(["b", "a"]);
    expect(repeated.map(({ externalId, score }) => ({ externalId, score }))).toEqual(
      result.map(({ externalId, score }) => ({ externalId, score })),
    );
    expect(result.every((item) => item.degraded === true)).toBe(true);
    expect(result.every((item) => item.degradedReason === "llm_rank_failed")).toBe(true);
    expect(result.every((item) => Number.isInteger(item.score))).toBe(true);
    const schema = mocks.completeJSON.mock.calls[0][0].schema as { parse: (value: unknown) => unknown };
    expect(() => schema.parse({ ranked: [{ idx: 0, score: 50, rationale: "a" }, { idx: 0, score: 49, rationale: "duplicate" }] })).toThrow();
    expect(() => schema.parse({ ranked: [{ idx: 99, score: 50, rationale: "out of range" }] })).toThrow();
    expect(() => schema.parse({ ranked: [{ idx: 0, score: 50.5, rationale: "fractional" }] })).toThrow();
  });

  test("fills a valid short model result deterministically without duplicate items", async () => {
    mocks.completeJSON.mockResolvedValue({ ranked: [{ idx: 1, score: 88, rationale: "strong signal" }] });
    const result = await rankTop(items, 2);
    expect(result.map((item) => item.externalId)).toEqual(["b", "a"]);
    expect(result.map((item) => item.rank)).toEqual([1, 2]);
    expect(result[0].degraded).toBeUndefined();
  });

  test("diversifies an exact Top 5 model result using scored recall alternatives", async () => {
    const crowded = Array.from({ length: 5 }, (_, index): NormalizedItem => ({
      source: "arxiv",
      externalId: `arxiv-${index}`,
      url: `https://example.com/arxiv-${index}`,
      title: `Arxiv ${index}`,
      authors: [],
      abstract: "AI paper",
      publishedAt: "2026-07-14T00:00:00.000Z",
      signals: { category: "cs.AI", sourceWeight: 5 },
    }));
    const alternatives: NormalizedItem[] = [
      { source: "github", externalId: "github-alt", url: "https://example.com/github-alt", title: "GitHub alternative", authors: [], abstract: "Engineering", publishedAt: "2026-07-14T00:00:00.000Z", signals: { category: "engineering", sourceWeight: 2 } },
      { source: "blog", externalId: "blog-alt", url: "https://example.com/blog-alt", title: "Blog alternative", authors: [], abstract: "Research", publishedAt: "2026-07-14T00:00:00.000Z", signals: { category: "research", sourceWeight: 2 } },
      { source: "openalex", externalId: "openalex-alt", url: "https://example.com/openalex-alt", title: "OpenAlex alternative", authors: [], abstract: "Multimodal", publishedAt: "2026-07-14T00:00:00.000Z", signals: { category: "multimodal", sourceWeight: 2 } },
    ];
    mocks.completeJSON.mockResolvedValue({
      ranked: crowded.map((_, idx) => ({ idx, score: 100 - idx, rationale: `model-${idx}` })),
    });

    const result = await rankTop([...crowded, ...alternatives], 5, "", new Date("2026-07-15T00:00:00.000Z"));
    expect(result).toHaveLength(5);
    expect(maxCount(result, (item) => item.source)).toBeLessThanOrEqual(3);
    expect(maxCount(result, (item) => String(item.signals.category))).toBeLessThanOrEqual(3);
    expect(result.some((item) => item.source !== "arxiv")).toBe(true);
    expect(result.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.every((item) => Number.isInteger(item.score))).toBe(true);
  });
});

test("diversification applies source caps before final rank assignment", () => {
  const candidates = [items[1], items[0], items[1], items[2]].map((base, index) => ({
    ...base,
    externalId: `${base.externalId}-${index}`,
    score: 100 - index,
    rank: index,
  }));
  const diversified = diversifyRanked(candidates, 4);
  expect(diversified.map((item) => item.source).slice(0, 3)).toEqual(["github", "arxiv", "blog"]);
  expect(diversified).toHaveLength(4);
});

test("diversification preserves each feasible cap when the other cap is impossible", () => {
  const sourceAlternatives = [
    ...Array.from({ length: 5 }, (_, index) => ({ ...items[0], externalId: `same-source-${index}`, score: 100 - index, rationale: "model", signals: { category: "shared" } })),
    { ...items[1], externalId: "other-source-1", score: 10, rationale: "fallback", signals: { category: "shared" } },
    { ...items[2], externalId: "other-source-2", score: 9, rationale: "fallback", signals: { category: "shared" } },
  ];
  const topicAlternatives = [
    ...Array.from({ length: 5 }, (_, index) => ({ ...items[0], externalId: `same-topic-${index}`, score: 100 - index, rationale: "model", signals: { category: "shared" } })),
    { ...items[0], externalId: "other-topic-1", score: 10, rationale: "fallback", signals: { category: "topic-b" } },
    { ...items[0], externalId: "other-topic-2", score: 9, rationale: "fallback", signals: { category: "topic-c" } },
  ];

  const sourceDiversified = diversifyRanked(sourceAlternatives, 5);
  const topicDiversified = diversifyRanked(topicAlternatives, 5);

  expect(maxCount(sourceDiversified, (item) => item.source)).toBeLessThanOrEqual(3);
  expect(maxCount(topicDiversified, (item) => String(item.signals.category))).toBeLessThanOrEqual(3);
});
