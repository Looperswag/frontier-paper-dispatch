import { XMLParser } from "fast-xml-parser";
import { httpText, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { ARXIV_CATEGORIES, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

// 用 arxiv 的 RSS 主机（rss.arxiv.org，当日新投稿）—— 比 export API 更稳更轻。
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function parseFeed(cat: string, xml: string): NormalizedItem[] {
  const items = toArray<any>(parser.parse(xml)?.rss?.channel?.item);
  return items
    .map((it) => {
      const link = String(it.link ?? "");
      const externalId = link.match(/abs\/(.+?)(?:v\d+)?$/)?.[1] ?? link;
      const abstract = clean(it.description).replace(
        /^arXiv:\S+\s+Announce Type:\s+\S+\s+Abstract:\s*/i,
        "",
      );
      const announce = clean(it["arxiv:announce_type"]); // new | cross | replace
      return {
        source: "arxiv" as const,
        externalId,
        url: link,
        title: clean(it.title),
        authors: clean(it["dc:creator"]).split(/,\s*/).filter(Boolean),
        abstract,
        publishedAt: String(it.pubDate ?? ""),
        signals: { sourceWeight: SOURCE_WEIGHTS.arxiv, category: cat, announce },
        _announce: announce,
      };
    })
    // 只要全新/交叉投稿，跳过 replace（旧文更新）。
    .filter((i) => i.title && i._announce !== "replace")
    .map(({ _announce, ...i }) => i);
}

export async function fetchArxiv(): Promise<NormalizedItem[]> {
  const settled = await Promise.allSettled(
    ARXIV_CATEGORIES.map(async (cat) =>
      parseFeed(cat, await httpText(`https://rss.arxiv.org/rss/${cat}`, { timeoutMs: 25_000 })),
    ),
  );
  const all = settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[arxiv] 跳过 ${ARXIV_CATEGORIES[i]}：${(r.reason as Error)?.message ?? r.reason}`);
    return [];
  });
  if (all.length === 0) {
    console.log("[arxiv] feed 无新投稿（arxiv 周末 skipDays，工作日恢复；HF daily papers 已覆盖高分 arxiv 论文）");
  }
  return all.slice(0, PER_SOURCE_LIMIT.arxiv);
}
