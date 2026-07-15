import { httpJSON, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

// HF daily papers 是已被社区筛过的当日 arxiv 论文，带 upvotes —— 绝佳排名信号。
export function validateHuggingFaceDailyPapers(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error("Hugging Face daily papers response must be an array");
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Hugging Face daily papers response contains an invalid entry");
    }
    const record = entry as Record<string, unknown>;
    const paperValue = Object.hasOwn(record, "paper") ? record.paper : record;
    if (!paperValue || typeof paperValue !== "object") {
      throw new Error("Hugging Face daily papers response contains an invalid paper");
    }
    const paper = paperValue as Record<string, unknown>;
    const id = paper.id ?? record.id;
    const title = paper.title ?? record.title;
    if (
      !((typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isFinite(id))) ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      throw new Error("Hugging Face daily papers response contains an incomplete paper");
    }
  }
  return value;
}

export async function fetchHuggingFace(): Promise<NormalizedItem[]> {
  const data = await httpJSON<any[]>("https://huggingface.co/api/daily_papers", {
    validate: validateHuggingFaceDailyPapers,
  });
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
