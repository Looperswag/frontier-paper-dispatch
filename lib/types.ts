export type SourceId = "arxiv" | "huggingface" | "github" | "blog" | "x" | "facebook";

/** 各 fetcher 归一化后的统一形态。 */
export interface NormalizedItem {
  source: SourceId;
  externalId: string; // 该源内稳定的 id（arxiv id / repo id / guid）
  url: string;
  title: string;
  authors: string[];
  abstract: string; // 摘要 / 描述
  content?: string; // 更长正文（如有）
  publishedAt: string; // ISO 8601
  signals: Record<string, number | string>; // 排名信号：upvotes / stars / category / sourceWeight ...
  raw?: unknown;
}

/** 排名后追加分数与理由。 */
export interface RankedItem extends NormalizedItem {
  score: number; // 0–100
  rank: number; // 1 = 最高
  rationale: string;
}

/** 总结后追加概要与影响。 */
export interface SummarizedItem extends RankedItem {
  oneLiner: string;
  summaryMd: string;
  impactMd: string;
}
