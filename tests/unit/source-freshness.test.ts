import { describe, expect, test, vi } from "vitest";
import { filterFreshItems, sourceFreshness } from "../../lib/source-freshness.ts";
import type { NormalizedItem } from "../../lib/types.ts";

const now = new Date("2026-07-14T12:00:00.000Z");

describe("source freshness", () => {
  test.each([
    ["missing", "", "missing"],
    ["invalid", "not-a-date", "invalid"],
    ["stale", "2026-07-11T11:59:59.999Z", "stale"],
    ["future", "2026-07-14T12:06:00.000Z", "future"],
  ])("rejects %s timestamps explicitly", (_label, value, reason) => {
    expect(sourceFreshness(value, now)).toEqual({ fresh: false, reason });
  });

  test("accepts an ISO timestamp inside the bounded lookback", () => {
    expect(sourceFreshness("2026-07-12T12:00:00.000Z", now)).toMatchObject({ fresh: true });
  });

  test("filters items and reports the source-specific reason", () => {
    const item = (externalId: string, publishedAt: string): NormalizedItem => ({
      source: "blog",
      externalId,
      url: "https://example.com",
      title: externalId,
      authors: [],
      abstract: "",
      publishedAt,
      signals: {},
    });
    const rejected = vi.fn();
    expect(filterFreshItems([
      item("fresh", "2026-07-14T11:00:00.000Z"),
      item("bad", ""),
    ], now, rejected)).toEqual([
      expect.objectContaining({ externalId: "fresh", publishedAt: "2026-07-14T11:00:00.000Z" }),
    ]);
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ externalId: "bad" }), "missing");
  });
});
