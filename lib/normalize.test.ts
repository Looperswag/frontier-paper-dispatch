import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupKey, normalizeTitle, titleHash, dedupe } from "./normalize.ts";
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
  assert.equal(dedupKey({ source: "arxiv", externalId: "2406.1" }), "arxiv:2406.1");
});

test("normalizeTitle ignores case, punctuation, whitespace", () => {
  assert.equal(normalizeTitle("Attention Is All You Need!"), "attention is all you need");
  assert.equal(
    normalizeTitle("  Attention,  is\nall   you need  "),
    "attention is all you need",
  );
});

test("titleHash equal for punctuation/case variants, different for different titles", () => {
  assert.equal(titleHash("Attention Is All You Need"), titleHash("attention is all you need!"));
  assert.notEqual(titleHash("Paper A"), titleHash("Paper B"));
});

test("dedupe merges same paper across sources and unions signals", () => {
  const items = [
    mk({ source: "arxiv", externalId: "2406.1", title: "Cool LLM Paper", abstract: "long abstract here" }),
    mk({ source: "huggingface", externalId: "2406.1", title: "Cool LLM Paper!", abstract: "", signals: { upvotes: 99 } }),
    mk({ source: "github", externalId: "999", title: "Unrelated Repo", signals: { stars: 5 } }),
  ];
  const out = dedupe(items);
  assert.equal(out.length, 2, "two distinct papers remain");
  const merged = out.find((i) => titleHash(i.title) === titleHash("Cool LLM Paper"))!;
  assert.equal(merged.abstract, "long abstract here", "keeps the richer abstract");
  assert.equal(merged.signals.upvotes, 99, "carries HF upvotes onto the merged row");
});

test("dedupe drops empty-title items", () => {
  assert.equal(dedupe([mk({ title: "  " })]).length, 0);
});
