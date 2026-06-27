import { httpJSON, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

// HF daily papers 是已被社区筛过的当日 arxiv 论文，带 upvotes —— 绝佳排名信号。
export async function fetchHuggingFace(): Promise<NormalizedItem[]> {
  const data = await httpJSON<any[]>("https://huggingface.co/api/daily_papers");
  return toArray<any>(data)
    .slice(0, PER_SOURCE_LIMIT.huggingface)
    .map((el) => {
      const p = el.paper ?? el;
      const id = String(p.id ?? el.id ?? "");
      return {
        source: "huggingface",
        externalId: id,
        url: `https://huggingface.co/papers/${id}`,
        title: clean(p.title ?? el.title),
        authors: toArray<any>(p.authors).map((a) => clean(a?.name ?? a)).filter(Boolean),
        abstract: clean(p.summary ?? el.summary),
        publishedAt: String(p.publishedAt ?? el.publishedAt ?? ""),
        signals: {
          sourceWeight: SOURCE_WEIGHTS.huggingface,
          upvotes: Number(p.upvotes ?? el.upvotes ?? 0),
        },
      } satisfies NormalizedItem;
    })
    .filter((i) => i.externalId && i.title);
}
