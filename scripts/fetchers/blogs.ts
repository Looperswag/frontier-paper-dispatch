import { XMLParser } from "fast-xml-parser";
import { httpText, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { BLOG_FEEDS, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const text = (v: any): string => clean(typeof v === "object" && v ? v["#text"] ?? "" : v);

async function fetchFeed(publisher: string, url: string): Promise<NormalizedItem[]> {
  let doc: any;
  try {
    doc = parser.parse(await httpText(url));
  } catch {
    console.warn(`[blogs] 跳过 ${publisher}（抓取/解析失败）`);
    return [];
  }
  const rss = toArray<any>(doc?.rss?.channel?.item);
  const atom = toArray<any>(doc?.feed?.entry);
  const isAtom = rss.length === 0 && atom.length > 0;
  const entries = (rss.length ? rss : atom).slice(0, PER_SOURCE_LIMIT.blog);

  return entries
    .map((it) => {
      const link = isAtom
        ? toArray<any>(it.link).find((l) => l?.["@_rel"] !== "self")?.["@_href"] ??
          toArray<any>(it.link)[0]?.["@_href"] ??
          ""
        : it.link;
      const guid = text(it.guid) || String(link) || text(it.title);
      return {
        source: "blog",
        externalId: String(guid),
        url: String(link ?? ""),
        title: text(it.title),
        authors: [],
        abstract: text(it.description ?? it.summary ?? it.content),
        publishedAt: String(it.pubDate ?? it.published ?? it.updated ?? ""),
        signals: { sourceWeight: SOURCE_WEIGHTS.blog, publisher },
      } satisfies NormalizedItem;
    })
    .filter((i) => i.title);
}

export async function fetchBlogs(): Promise<NormalizedItem[]> {
  const settled = await Promise.allSettled(BLOG_FEEDS.map((f) => fetchFeed(f.publisher, f.url)));
  return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
