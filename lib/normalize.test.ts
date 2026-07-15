import { expect, test } from "vitest";
import { canonicalWorkKey, dedupKey, normalizeTitle, normalizeWorkUrl, titleHash, dedupe } from "./normalize.ts";
import type { NormalizedItem } from "./types.ts";

const mk = (over: Partial<NormalizedItem>): NormalizedItem => ({
  source: "arxiv",
  externalId: "x",
  url: "u",
  title: "t",
  authors: [],
  abstract: "",
  publishedAt: "2026-06-27",
  signals: {},
  ...over,
});

test("dedupKey combines source + externalId", () => {
  expect(dedupKey({ source: "arxiv", externalId: "2406.1" })).toBe("arxiv:2406.1");
});

test("normalizeTitle ignores case, punctuation, whitespace", () => {
  expect(normalizeTitle("Attention Is All You Need!")).toBe("attention is all you need");
  expect(normalizeTitle("  Attention,  is\nall   you need  ")).toBe("attention is all you need");
});

test("titleHash equal for punctuation/case variants, different for different titles", () => {
  expect(titleHash("Attention Is All You Need")).toBe(titleHash("attention is all you need!"));
  expect(titleHash("Paper A")).not.toBe(titleHash("Paper B"));
});

test("dedupe merges same paper across sources and unions signals", () => {
  const items = [
    mk({ source: "arxiv", externalId: "2406.1", title: "Cool LLM Paper", abstract: "long abstract here" }),
    mk({ source: "huggingface", externalId: "2406.1", title: "Cool LLM Paper!", abstract: "", signals: { upvotes: 99 } }),
    mk({ source: "github", externalId: "999", title: "Unrelated Repo", signals: { stars: 5 } }),
  ];
  const out = dedupe(items);
  expect(out, "two distinct papers remain").toHaveLength(2);
  const merged = out.find((i) => titleHash(i.title) === titleHash("Cool LLM Paper"))!;
  expect(merged.abstract, "keeps the richer abstract").toBe("long abstract here");
  expect(merged.signals.upvotes, "carries HF upvotes onto the merged row").toBe(99);
});

test("dedupe drops empty-title items", () => {
  expect(dedupe([mk({ title: "  " })])).toHaveLength(0);
});

test("canonical work identity prefers arXiv/DOI IDs and strips tracking URLs", () => {
  expect(canonicalWorkKey(mk({ source: "huggingface", externalId: "2406.12345v2" }))).toBe("arxiv:2406.12345");
  expect(canonicalWorkKey(mk({ source: "blog", externalId: "entry", url: "https://doi.org/10.1234/ABC?utm_source=x" }))).toBe("doi:10.1234/abc");
  expect(canonicalWorkKey(mk({ source: "blog", externalId: "entry", url: "https://openreview.net/forum?id=AbC" }))).toBe("openreview:AbC");
  expect(canonicalWorkKey(mk({ source: "blog", externalId: "entry", url: "https://aclanthology.org/2024.acl-long.1/" }))).toBe("acl:2024.acl-long.1");
  expect(normalizeWorkUrl("http://Example.COM/paper/?utm_campaign=test#section")).toBe("https://example.com/paper");
});

test("canonical URL identities preserve encoded bytes and normalize the default HTTPS port", () => {
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "entry",
    url: "https://openreview.net/forum?id=Ab%2FC",
  }))).toBe("openreview:Ab%2FC");
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "entry",
    url: "https://openreview.net:443/forum?id=AbC",
  }))).toBe("openreview:AbC");
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "entry",
    url: "https://doi.org/10.1234/AB%2FC",
  }))).toBe("doi:10.1234/ab%2fc");
});

test("canonical identity only removes arXiv versions and never throws on malformed URL escapes", () => {
  expect(canonicalWorkKey(mk({ source: "blog", externalId: "releasev2", url: "https://example.com/release-v2" }))).toBe("blog:releasev2");
  expect(() => canonicalWorkKey(mk({
    source: "openreview",
    externalId: "bad%id",
    url: "https://openreview.net/forum?id=bad%id",
  }))).not.toThrow();
});

test("canonical identity trusts provider hosts instead of lookalike hostnames or coincidental IDs", () => {
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "2406.12345v2",
    url: "https://example.com/posts/2406.12345v2",
  }))).toBe("blog:2406.12345v2");
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "entry",
    url: "https://evilopenreview.net/forum?id=AbC",
  }))).toBe("blog:entry");
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "entry",
    url: "https://notaclanthology.org/2024.acl-long.1/",
  }))).toBe("blog:entry");
  expect(canonicalWorkKey(mk({
    source: "blog",
    externalId: "2406.12345v2",
    url: "https://arxiv.org/abs/2406.12345v2",
  }))).toBe("blog:2406.12345v2");
});

test("opaque source IDs remain stable when publisher metadata changes", () => {
  const first = canonicalWorkKey(mk({
    source: "blog",
    externalId: "https://example.com/posts/stable-guid",
    title: "Original title",
    authors: ["Alice"],
  }));
  const revised = canonicalWorkKey(mk({
    source: "blog",
    externalId: "https://example.com/posts/stable-guid",
    title: "Publisher revised the title",
    authors: ["Bob"],
  }));
  expect(first).toMatch(/^blog:id:[a-f0-9]{64}$/);
  expect(revised).toBe(first);
});

test("source-local IDs preserve case instead of collapsing case-sensitive identities", () => {
  expect(canonicalWorkKey(mk({ source: "github", externalId: "Owner/Repo" })))
    .not.toBe(canonicalWorkKey(mk({ source: "github", externalId: "owner/repo" })));
});

test("canonical source normalization matches the database contract", () => {
  expect(canonicalWorkKey(mk({ source: " Blog " as NormalizedItem["source"], externalId: "stable-id" })))
    .toBe("blog:stable-id");
  expect(canonicalWorkKey(mk({ source: "Blog Source" as NormalizedItem["source"], externalId: "stable-id" })))
    .toMatch(/^source:id:[a-f0-9]{64}$/);
});

test("dedupe retains source observations when providers expose the same work", () => {
  const [merged] = dedupe([
    mk({ source: "arxiv", externalId: "2406.12345", url: "https://arxiv.org/abs/2406.12345", title: "Same Work" }),
    mk({ source: "huggingface", externalId: "2406.12345", url: "https://huggingface.co/papers/2406.12345", title: "Same Work" }),
  ]);
  expect(merged.provenance).toEqual([
    { source: "arxiv", externalId: "2406.12345", url: "https://arxiv.org/abs/2406.12345", signals: {} },
    { source: "huggingface", externalId: "2406.12345", url: "https://huggingface.co/papers/2406.12345", signals: {} },
  ]);
});

test("dedupe keeps the latest same-source observation and identity despite URL drift", () => {
  const [merged] = dedupe([
    mk({
      source: "blog",
      externalId: "stable-entry",
      url: "https://example.com/stable-entry",
      title: "Stable entry",
      provenance: [{
        source: "blog",
        externalId: "stable-entry",
        url: "https://example.com/stable-entry",
        signals: { views: 1 },
      }],
    }),
    mk({
      source: "blog",
      externalId: "stable-entry",
      url: "https://doi.org/10.1234/stable-entry",
      title: "Stable entry DOI",
      provenance: [{
        source: "blog",
        externalId: "stable-entry",
        url: "https://doi.org/10.1234/stable-entry",
        signals: { views: 2 },
      }],
    }),
  ]);
  expect(dedupe([
    mk({ source: "blog", externalId: "stable-entry", url: "https://example.com/stable-entry" }),
    mk({ source: "blog", externalId: "stable-entry", url: "https://doi.org/10.1234/stable-entry" }),
  ])).toHaveLength(1);
  expect(merged.provenance).toEqual([{
    source: "blog",
    externalId: "stable-entry",
    url: "https://doi.org/10.1234/stable-entry",
    signals: { views: 2 },
  }]);
});

test("dedupe drops one oversized source identity before it can abort a bulk upsert", () => {
  const valid = mk({ source: "blog", externalId: "valid", url: "https://example.com/valid", title: "Valid" });
  const oversized = mk({
    source: "blog",
    externalId: "x".repeat(513),
    url: "https://example.com/oversized",
    title: "Oversized",
  });
  expect(dedupe([oversized, valid])).toEqual([expect.objectContaining({ externalId: "valid" })]);
});
