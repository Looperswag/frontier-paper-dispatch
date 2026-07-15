import { expect, test } from "vitest";
import {
  ACL_SELECTED_VENUES,
  DISABLED_SOURCE_REGISTRY,
  SOURCE_REGISTRY,
} from "../../config/sources.ts";
import { ACTIVE_FETCHERS } from "../../scripts/ingest.ts";

test("active source registry records compliance metadata and excludes unimplemented social/search scraping", () => {
  expect(SOURCE_REGISTRY.map((source) => source.id)).toEqual([
    "arxiv",
    "huggingface",
    "github",
    "blog",
    "acl",
    "openalex",
  ]);
  for (const source of SOURCE_REGISTRY) {
    expect(source.officialUrl).toMatch(/^https:\/\//);
    expect(source.robots).toBe("honor");
    expect(source.rateLimit.length).toBeGreaterThan(0);
    expect(source.license.length).toBeGreaterThan(0);
    expect(source.retention).toMatch(/metadata|abstract|description|summary/);
    expect(source.healthContract.length).toBeGreaterThan(0);
  }
  expect(ACTIVE_FETCHERS.map(([id]) => id)).toEqual(SOURCE_REGISTRY.map(({ id }) => id));
});

test("selected ACL venues are explicit and OpenReview remains fail-closed", () => {
  expect(ACL_SELECTED_VENUES).toEqual([
    "acl",
    "emnlp",
    "naacl",
    "eacl",
    "aacl",
    "conll",
    "tacl",
    "cl",
  ]);
  expect(SOURCE_REGISTRY.some(({ id }) => id === "openreview")).toBe(false);
  expect(ACTIVE_FETCHERS.some(([id]) => id === "openreview")).toBe(false);
  expect(DISABLED_SOURCE_REGISTRY).toEqual([
    expect.objectContaining({
      id: "openreview",
      state: "disabled",
      anonymousStatus: 403,
      failureMode: expect.stringMatching(/excluded/i),
    }),
  ]);
});
