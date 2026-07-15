import { expect, test } from "vitest";
import {
  applyGitHubRelease,
  combineGitHubSearchResults,
  githubVelocity,
  orderGitHubCandidates,
} from "../../scripts/fetchers/github.ts";
import type { NormalizedItem } from "../../lib/types.ts";

test("GitHub ranking signal favors recent star velocity over evergreen totals", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  expect(githubVelocity({ stargazers_count: 100, created_at: "2026-07-14T00:00:00.000Z" }, now)).toBe(100);
  expect(githubVelocity({ stargazers_count: 1000, created_at: "2024-07-15T00:00:00.000Z" }, now)).toBeLessThan(2);
});

const repository = (externalId: string, velocity: number, stars: number, publishedAt: string): NormalizedItem => ({
  source: "github",
  externalId,
  url: `https://github.com/example/${externalId}`,
  title: externalId,
  authors: [],
  abstract: "",
  publishedAt,
  signals: { starVelocity: velocity, stars },
});

test("GitHub release enrichment selects the actual velocity-ranked candidates", () => {
  const ordered = orderGitHubCandidates([
    repository("inserted-first", 1, 1000, "2026-07-15T00:00:00Z"),
    repository("fast", 20, 10, "2026-07-15T00:00:00Z"),
    repository("medium", 10, 20, "2026-07-15T00:00:00Z"),
  ]);
  expect(ordered.map((item) => item.externalId)).toEqual(["fast", "medium", "inserted-first"]);
});

test("an old or future-dated release never makes a recently pushed repository stale or future-fresh", () => {
  const item = repository("active", 5, 10, "2026-07-15T10:00:00Z");
  applyGitHubRelease(item, { published_at: "2025-01-01T00:00:00Z", tag_name: "v1", html_url: "https://github.com/example/active/releases/v1" }, Date.parse("2026-07-15T12:00:00Z"));
  expect(item.publishedAt).toBe("2026-07-15T10:00:00Z");
  applyGitHubRelease(item, { published_at: "2027-01-01T00:00:00Z", tag_name: "v2", html_url: "https://github.com/example/active/releases/v2" }, Date.parse("2026-07-15T12:00:00Z"));
  expect(item.publishedAt).toBe("2026-07-15T10:00:00Z");
});

test("GitHub is failed rather than falsely empty when every search request fails", () => {
  const failures = [
    Promise.reject(new Error("rate limited")),
    Promise.reject(new Error("network unavailable")),
  ];

  return Promise.allSettled(failures).then((results) => {
    expect(() => combineGitHubSearchResults(results, ["llm"], { warn: () => undefined }))
      .toThrow("all GitHub repository searches failed");
  });
});

test("GitHub remains available in a partial-search degradation", async () => {
  const logger = { warn: () => undefined };
  const results = await Promise.allSettled([
    Promise.resolve([{ id: 1 }]),
    Promise.reject(new Error("one mode failed")),
  ]);

  expect(combineGitHubSearchResults(results, ["llm"], logger)).toEqual([{ id: 1 }]);
});
