import { describe, expect, test } from "vitest";
import {
  ARXIV_CATEGORIES,
  BLOG_FEEDS,
  GITHUB_TOPICS,
  LOOKBACK_DAYS,
  PER_SOURCE_LIMIT,
  SOURCE_WEIGHTS,
} from "../../config/sources.ts";

describe("source configuration contract", () => {
  test("uses unique HTTPS first-party feed endpoints", () => {
    const publishers = BLOG_FEEDS.map(({ publisher }) => publisher);
    const urls = BLOG_FEEDS.map(({ url }) => url);

    expect(new Set(publishers).size).toBe(publishers.length);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(new URL(url).protocol).toBe("https:");
    expect(publishers).toContain("Apple Machine Learning Research");
    expect(publishers).toContain("Microsoft Research");
    expect(urls).toContain("https://machinelearning.apple.com/rss.xml");
    expect(urls).toContain("https://www.microsoft.com/en-us/research/blog/feed/");
  });

  test("keeps categories, topics, weights, limits, and lookback bounded", () => {
    expect(new Set(ARXIV_CATEGORIES).size).toBe(ARXIV_CATEGORIES.length);
    expect(new Set(GITHUB_TOPICS).size).toBe(GITHUB_TOPICS.length);
    expect(Object.values(SOURCE_WEIGHTS).every((weight) => Number.isFinite(weight) && weight > 0)).toBe(true);
    expect(Object.values(PER_SOURCE_LIMIT).every((limit) => Number.isInteger(limit) && limit > 0)).toBe(true);
    expect(Number.isInteger(LOOKBACK_DAYS) && LOOKBACK_DAYS > 0).toBe(true);
  });

  test("covers retrieval and multi-agent research without changing the arXiv cap", () => {
    expect(ARXIV_CATEGORIES).toEqual([
      "cs.AI",
      "cs.CL",
      "cs.LG",
      "cs.CV",
      "stat.ML",
      "cs.IR",
      "cs.MA",
    ]);
    expect(PER_SOURCE_LIMIT.arxiv).toBe(30);
  });
});
