import { XMLParser, XMLValidator } from "fast-xml-parser";
import { httpHTML, httpText, clean } from "../../lib/http.ts";
import { normalizeWorkUrl, toArray } from "../../lib/normalize.ts";
import { safeErrorMessage } from "../../lib/safe-error.ts";
import { BLOG_FEEDS, PER_SOURCE_LIMIT, SOURCE_WEIGHTS, type BlogSource } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export const BLOG_FEED_REQUEST_BOUNDS = Object.freeze({
  deadlineMs: 35_000,
  maxAttempts: 2,
  maxResponseBytes: 1024 * 1024,
  redirect: "error" as const,
  timeoutMs: 15_000,
});

const text = (v: any): string => clean(typeof v === "object" && v ? v["#text"] ?? "" : v);

export function stripHtml(value: string): string {
  return clean(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"));
}

export function extractPageContent(html: string): { title: string; description: string; body: string } {
  const title = stripHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = stripHtml(
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "",
  );
  const article = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] ?? html;
  return { title: title.slice(0, 512), description: description.slice(0, 2_048), body: stripHtml(article).slice(0, 4_096) };
}

export function isTrustedBlogPageURL(value: string, allowedHosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return allowedHosts.some((allowed) => {
      const normalized = allowed.toLowerCase().replace(/^www\./, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

export function isAllowedBlogPageURL(
  value: string,
  source: Pick<BlogSource, "allowedPathPrefixes" | "pageHosts">,
): boolean {
  if (!isTrustedBlogPageURL(value, source.pageHosts)) return false;
  const prefixes = source.allowedPathPrefixes ?? ["/"];
  try {
    const pathname = new URL(value).pathname;
    return prefixes.some((prefix) => prefix.startsWith("/") && pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

interface SitemapOptions {
  allowedPathPrefixes?: readonly string[];
  pageHosts: readonly string[];
  publisher: string;
}

export function mapSitemapItems(document: any, source: SitemapOptions): NormalizedItem[] {
  return toArray<any>(document?.urlset?.url)
    .flatMap((entry) => {
      const url = clean(entry?.loc);
      const publishedAt = clean(entry?.lastmod);
      if (!isAllowedBlogPageURL(url, source) || !Number.isFinite(Date.parse(publishedAt))) return [];
      const parsed = new URL(url);
      const slug = parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
      let title = slug;
      try { title = decodeURIComponent(slug); } catch { /* keep the bounded URL slug */ }
      return [{
        source: "blog",
        externalId: url,
        url,
        title: clean(title.replace(/[-_]+/g, " ")).slice(0, 512),
        authors: [],
        abstract: "",
        publishedAt,
        signals: { sourceWeight: SOURCE_WEIGHTS.blog, publisher: source.publisher },
      } satisfies NormalizedItem];
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.url.localeCompare(b.url))
    .slice(0, PER_SOURCE_LIMIT.blog);
}

export function parseBlogSourceDocument(xml: string, source: BlogSource): any {
  if (XMLValidator.validate(xml) !== true) {
    throw new Error(`${source.publisher} source returned invalid XML`);
  }
  let document: any;
  try {
    document = parser.parse(xml);
  } catch {
    throw new Error(`${source.publisher} source XML could not be parsed`);
  }
  const matchesSchema = source.kind === "sitemap"
    ? document?.urlset && typeof document.urlset === "object"
    : (document?.rss?.channel && typeof document.rss.channel === "object") ||
      (document?.feed && typeof document.feed === "object") ||
      (document?.["atom:feed"] && typeof document["atom:feed"] === "object");
  if (!matchesSchema) throw new Error(`${source.publisher} source does not match the ${source.kind} schema`);
  return document;
}

async function fetchFeed(source: BlogSource): Promise<NormalizedItem[]> {
  const xml = await httpText(source.url, {
    ...BLOG_FEED_REQUEST_BOUNDS,
  });
  const doc = parseBlogSourceDocument(xml, source);
  if (source.kind === "sitemap") return enrichItems(mapSitemapItems(doc, source), source, 4);
  const rss = toArray<any>(doc?.rss?.channel?.item);
  const atom = toArray<any>((doc?.feed ?? doc?.["atom:feed"])?.entry);
  const isAtom = rss.length === 0 && atom.length > 0;
  const entries = (rss.length ? rss : atom).slice(0, PER_SOURCE_LIMIT.blog);

  const mapped = entries
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
        url: normalizeWorkUrl(String(link ?? "")),
        title: text(it.title),
        authors: [],
        abstract: stripHtml(text(it.description ?? it.summary ?? it.content)).slice(0, 4_096),
        publishedAt: String(it.pubDate ?? it.published ?? it.updated ?? ""),
        signals: { sourceWeight: SOURCE_WEIGHTS.blog, publisher: source.publisher },
      } satisfies NormalizedItem;
    })
    .filter((item) => item.title && isAllowedBlogPageURL(item.url, source));
  return enrichItems(mapped, source, 2);
}

export function combineBlogSourceResults(
  sources: readonly BlogSource[],
  results: readonly PromiseSettledResult<NormalizedItem[]>[],
  logger: Pick<Console, "warn"> = console,
): NormalizedItem[] {
  const successful: NormalizedItem[][] = [];
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successful.push(result.value);
      return;
    }
    failures.push(result.reason);
    logger.warn(
      `[blogs] ${sources[index]?.publisher ?? "unknown publisher"} 失败：${safeErrorMessage(result.reason)}`,
    );
  });
  if (successful.length === 0) {
    throw new AggregateError(failures, "all configured blog sources failed");
  }
  return successful.flat();
}

async function enrichItems(items: NormalizedItem[], source: BlogSource, limit: number): Promise<NormalizedItem[]> {
  return Promise.all(items.map(async (item, index) => {
    if (index >= limit || item.abstract.length >= 240 || !isAllowedBlogPageURL(item.url, source)) return item;
    try {
      const page = extractPageContent(await httpHTML(item.url, {
        maxAttempts: 1,
        maxResponseBytes: 256 * 1024,
        timeoutMs: 8_000,
        deadlineMs: 10_000,
        redirect: "error",
      }));
      return {
        ...item,
        title: item.title || page.title,
        abstract: page.description || page.body || item.abstract,
        content: page.body || undefined,
      };
    } catch {
      return item;
    }
  }));
}

export async function fetchBlogs(): Promise<NormalizedItem[]> {
  const settled = await Promise.allSettled(BLOG_FEEDS.map(fetchFeed));
  return combineBlogSourceResults(BLOG_FEEDS, settled);
}
