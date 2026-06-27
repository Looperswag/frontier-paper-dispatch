import crypto from "node:crypto";
import type { NormalizedItem } from "./types.ts";

export const toArray = <T>(x: T | T[] | null | undefined): T[] =>
  Array.isArray(x) ? x : x == null ? [] : [x];

/** 源内主键：source + externalId（Supabase 也按这两列做唯一约束去重）。 */
export const dedupKey = (i: { source: string; externalId: string }): string =>
  `${i.source}:${i.externalId}`;

/** 标题归一化：小写、压空白、去标点（含 CJK 安全的 Unicode 类）。 */
export function normalizeTitle(t: string): string {
  return (t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 跨源去重键：同一篇论文在 arxiv 与 HF daily papers 会同时出现，用标题哈希合并。 */
export const titleHash = (title: string): string =>
  crypto.createHash("sha1").update(normalizeTitle(title)).digest("hex").slice(0, 12);

function merge(a: NormalizedItem, b: NormalizedItem): NormalizedItem {
  // 保留摘要更长的一条为主，合并双方 signals（保留各自数值信号如 upvotes/stars）。
  const primary = (b.abstract?.length ?? 0) > (a.abstract?.length ?? 0) ? b : a;
  const other = primary === a ? b : a;
  return {
    ...primary,
    abstract: primary.abstract || other.abstract,
    content: primary.content || other.content,
    signals: { ...other.signals, ...primary.signals, mergedFrom: `${a.source}+${b.source}` },
  };
}

/** 跨源 + 源内去重：标题相同视为同一篇，合并信号。 */
export function dedupe(items: NormalizedItem[]): NormalizedItem[] {
  const byTitle = new Map<string, NormalizedItem>();
  for (const it of items) {
    if (!it.title?.trim()) continue;
    const key = titleHash(it.title);
    const prev = byTitle.get(key);
    byTitle.set(key, prev ? merge(prev, it) : it);
  }
  return [...byTitle.values()];
}
