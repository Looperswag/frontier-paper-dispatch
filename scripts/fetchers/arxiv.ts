import { XMLParser, XMLValidator } from "fast-xml-parser";
import { httpText, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { ARXIV_CATEGORIES, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

// arXiv 官方 RSS 支持用 `+` 合并分类；每轮只请求一次，避免多分类并发打到提供方。
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const combinedFeedUrl = `https://rss.arxiv.org/rss/${ARXIV_CATEGORIES.join("+")}`;
const categoryByLowercase = new Map(
  ARXIV_CATEGORIES.map((category) => [category.toLowerCase(), category]),
);
const arxivIdPattern = String.raw`(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})`;
const exactArxivId = new RegExp(
  String.raw`^(?:oai:arxiv\.org:|arxiv:)?(${arxivIdPattern})(?:v(\d+))?$`,
  "i",
);
const arxivPath = new RegExp(
  String.raw`^\/(?:abs|pdf)\/(${arxivIdPattern})(?:v(\d+))?(?:\.pdf)?\/?$`,
  "i",
);

interface ArxivIdentity {
  externalId: string;
  version?: number;
}

interface CategorizedItem {
  categories: string[];
  item: NormalizedItem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return clean(record["#text"] ?? record.name ?? "");
  }
  return clean(value);
}

function normalizeExternalId(value: string): string {
  return value.includes("/") ? value.toLowerCase() : value;
}

function identityCandidate(candidate: unknown): ArxivIdentity | undefined {
  let value = text(candidate);
  if (!value) return undefined;
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed candidate is checked in its original form and normally rejected.
  }

  const exact = value.match(exactArxivId);
  if (exact) {
    return {
      externalId: normalizeExternalId(exact[1]),
      version: exact[2] ? Number(exact[2]) : undefined,
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.hostname !== "arxiv.org" && !url.hostname.endsWith(".arxiv.org"))
  ) {
    return undefined;
  }

  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = pathname.match(arxivPath);
  if (!path) return undefined;
  return {
    externalId: normalizeExternalId(path[1]),
    version: path[2] ? Number(path[2]) : undefined,
  };
}

function canonicalArxivIdentity(...candidates: unknown[]): ArxivIdentity | undefined {
  const matches = candidates
    .map(identityCandidate)
    .filter((identity): identity is ArxivIdentity => identity !== undefined);
  if (matches.length === 0) return undefined;

  const externalId = matches[0].externalId;
  if (matches.some((identity) => identity.externalId !== externalId)) return undefined;
  const versions = matches
    .map(({ version }) => version)
    .filter((version): version is number => version !== undefined);
  return {
    externalId,
    version: versions.length > 0 ? Math.max(...versions) : undefined,
  };
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysByMonth[month - 1];
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  const iso = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/,
  );
  const rfc = raw.match(
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+(?:UT|GMT|[ECMP][SD]T|[+-](?:(?:0\d|1[0-3])[0-5]\d|1400))$/i,
  );
  let year: number;
  let month: number;
  let day: number;

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (rfc) {
    const monthIndex = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(rfc[2].toLowerCase());
    if (monthIndex < 0) return undefined;
    year = Number(rfc[3]);
    month = monthIndex + 1;
    day = Number(rfc[1]);
  } else {
    return undefined;
  }

  if (!isCalendarDate(year, month, day)) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function categories(value: unknown): string[] {
  return toArray<any>(value)
    .map((category) =>
      typeof category === "object" && category !== null
        ? text(category["@_term"] ?? category)
        : text(category),
    )
    .filter(Boolean);
}

function configuredCategories(primary: unknown, listed: unknown): string[] {
  const configured: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [text(primary), ...categories(listed)]) {
    const category = categoryByLowercase.get(candidate.toLowerCase());
    if (!category || seen.has(category)) continue;
    seen.add(category);
    configured.push(category);
  }
  return configured;
}

function announceType(explicit: unknown, description: string): string {
  return text(explicit) || description.match(/Announce Type:\s*([^\s]+)/i)?.[1] || "";
}

function rssAuthors(value: unknown): string[] {
  return text(value).split(/,\s*/).filter(Boolean);
}

function atomField(record: any, name: string): unknown {
  return record?.[name] ?? record?.[`atom:${name}`];
}

function hasAtomField(record: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(record, name) || Object.hasOwn(record, `atom:${name}`);
}

function matchesRssItemSchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.hasOwn(value, "title") &&
    (Object.hasOwn(value, "link") || Object.hasOwn(value, "guid")) &&
    Object.hasOwn(value, "pubDate") &&
    Object.hasOwn(value, "category")
  );
}

function matchesAtomEntrySchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasAtomField(value, "title") &&
    (hasAtomField(value, "link") || hasAtomField(value, "id")) &&
    hasAtomField(value, "published") &&
    (hasAtomField(value, "category") || Object.hasOwn(value, "arxiv:primary_category"))
  );
}

function atomAuthors(value: unknown): string[] {
  return toArray<any>(value)
    .map((author) => text(atomField(author, "name") ?? author))
    .filter(Boolean);
}

function atomLink(entry: any): string {
  const links = toArray<any>(atomField(entry, "link"));
  const alternate = links.find((link) => text(link?.["@_rel"]).toLowerCase() === "alternate");
  return text(alternate?.["@_href"] ?? links[0]?.["@_href"] ?? atomField(entry, "id"));
}

function normalizeEntry(input: {
  title: unknown;
  description: unknown;
  announce: unknown;
  publishedAt: unknown;
  link: unknown;
  id: unknown;
  guid?: unknown;
  primaryCategory?: unknown;
  listedCategories: unknown;
  authors: string[];
}): CategorizedItem | undefined {
  const title = text(input.title);
  const rawDescription = text(input.description);
  const announce = announceType(input.announce, rawDescription);
  const publishedAt = isoDate(input.publishedAt);
  const identity = canonicalArxivIdentity(input.link, input.id, input.guid);
  const configured = configuredCategories(input.primaryCategory, input.listedCategories);
  const isReplacement = announce.toLowerCase().startsWith("replace");
  const isUnlabelledRevision = !announce && (identity?.version ?? 1) > 1;

  if (
    !title ||
    !publishedAt ||
    !identity ||
    configured.length === 0 ||
    isReplacement ||
    isUnlabelledRevision
  ) {
    return undefined;
  }

  const abstract = rawDescription.replace(
    /^arXiv:\S+\s+Announce Type:\s+\S+\s+Abstract:\s*/i,
    "",
  );
  return {
    categories: configured,
    item: {
      source: "arxiv",
      externalId: identity.externalId,
      url: `https://arxiv.org/abs/${identity.externalId}`,
      title,
      authors: input.authors,
      abstract,
      publishedAt,
      signals: { sourceWeight: SOURCE_WEIGHTS.arxiv, announce },
    },
  };
}

function parseFeed(xml: string): CategorizedItem[] {
  if (XMLValidator.validate(xml) !== true) {
    throw new Error("arXiv feed XML is invalid");
  }

  let parsed: Record<string, unknown>;
  try {
    const value = parser.parse(xml);
    if (!isRecord(value)) throw new Error("parsed XML is not an object");
    parsed = value;
  } catch {
    throw new Error("arXiv feed XML could not be parsed");
  }

  if (Object.hasOwn(parsed, "rss")) {
    const rss = parsed.rss;
    if (!isRecord(rss) || !Object.hasOwn(rss, "channel")) {
      throw new Error("arXiv feed does not match the RSS schema");
    }
    const channel = rss.channel;
    if (channel !== "" && !isRecord(channel)) {
      throw new Error("arXiv feed does not match the RSS schema");
    }
    if (channel === "") return [];
    const rssItems = toArray<any>(channel.item);
    if (rssItems.length > 0 && !rssItems.every(matchesRssItemSchema)) {
      throw new Error("arXiv feed does not match the RSS item schema");
    }
    return rssItems
      .map((item) =>
        normalizeEntry({
          title: item.title,
          description: item.description,
          announce: item["arxiv:announce_type"],
          publishedAt: item.pubDate,
          link: item.link,
          id: item.guid,
          guid: item.guid,
          listedCategories: item.category,
          authors: rssAuthors(item["dc:creator"]),
        }),
      )
      .filter((item): item is CategorizedItem => item !== undefined);
  }

  const hasDefaultAtomRoot = Object.hasOwn(parsed, "feed");
  const hasPrefixedAtomRoot = Object.hasOwn(parsed, "atom:feed");
  if (hasDefaultAtomRoot || hasPrefixedAtomRoot) {
    const feed = parsed[hasDefaultAtomRoot ? "feed" : "atom:feed"];
    if (feed !== "" && !isRecord(feed)) {
      throw new Error("arXiv feed does not match the Atom schema");
    }
    if (feed === "") return [];
    const atomEntries = toArray<any>(atomField(feed, "entry"));
    if (atomEntries.length > 0 && !atomEntries.every(matchesAtomEntrySchema)) {
      throw new Error("arXiv feed does not match the Atom entry schema");
    }
    return atomEntries
      .map((entry) =>
        normalizeEntry({
          title: atomField(entry, "title"),
          description: atomField(entry, "summary"),
          announce: entry["arxiv:announce_type"],
          publishedAt: atomField(entry, "published"),
          link: atomLink(entry),
          id: atomField(entry, "id"),
          primaryCategory: entry["arxiv:primary_category"]?.["@_term"],
          listedCategories: atomField(entry, "category"),
          authors: atomAuthors(atomField(entry, "author")),
        }),
      )
      .filter((item): item is CategorizedItem => item !== undefined);
  }

  throw new Error("arXiv feed has an unsupported RSS/Atom root");
}

function fairLimit(items: CategorizedItem[], limit: number): NormalizedItem[] {
  const uniqueById = new Map<string, CategorizedItem>();
  for (const candidate of items) {
    const existing = uniqueById.get(candidate.item.externalId);
    if (!existing) {
      uniqueById.set(candidate.item.externalId, {
        categories: [...candidate.categories],
        item: candidate.item,
      });
      continue;
    }
    for (const category of candidate.categories) {
      if (!existing.categories.includes(category)) existing.categories.push(category);
    }
  }

  const unique = [...uniqueById.values()];
  const buckets = new Map(ARXIV_CATEGORIES.map((category) => [category, [] as CategorizedItem[]]));
  for (const candidate of unique) {
    for (const category of candidate.categories) buckets.get(category)?.push(candidate);
  }
  for (const bucket of buckets.values()) {
    // Preserve scarce cross-listed entries for categories that have no single-category alternatives.
    bucket.sort((left, right) => left.categories.length - right.categories.length);
  }

  const configuredOrder = new Map(ARXIV_CATEGORIES.map((category, index) => [category, index]));
  const categoryPriority = (category: string): [number, number, number] => {
    let preference = Number.POSITIVE_INFINITY;
    let feedPosition = Number.POSITIVE_INFINITY;
    unique.forEach((candidate, index) => {
      const candidatePreference = candidate.categories.indexOf(category);
      if (
        candidatePreference >= 0 &&
        (candidatePreference < preference ||
          (candidatePreference === preference && index < feedPosition))
      ) {
        preference = candidatePreference;
        feedPosition = index;
      }
    });
    return [preference, feedPosition, configuredOrder.get(category) ?? Number.POSITIVE_INFINITY];
  };
  const allocationOrder = [...ARXIV_CATEGORIES].sort((left, right) => {
    const leftPriority = categoryPriority(left);
    const rightPriority = categoryPriority(right);
    return (
      leftPriority[0] - rightPriority[0] ||
      leftPriority[1] - rightPriority[1] ||
      leftPriority[2] - rightPriority[2]
    );
  });

  const assignments = new Map<string, string>();
  const augment = (
    category: string,
    visitedItems: Set<string>,
    visitedCategories: Set<string>,
  ): boolean => {
    if (visitedCategories.has(category)) return false;
    visitedCategories.add(category);

    for (const candidate of buckets.get(category) ?? []) {
      const externalId = candidate.item.externalId;
      const assignedCategory = assignments.get(externalId);
      if (assignedCategory === category || visitedItems.has(externalId)) continue;
      visitedItems.add(externalId);

      if (
        assignedCategory === undefined ||
        augment(assignedCategory, visitedItems, visitedCategories)
      ) {
        assignments.set(externalId, category);
        return true;
      }
    }
    return false;
  };

  let progressed = true;
  while (assignments.size < limit && progressed) {
    progressed = false;
    for (const category of allocationOrder) {
      if (augment(category, new Set(), new Set())) progressed = true;
      if (assignments.size === limit) break;
    }
  }

  return unique.flatMap((candidate) => {
    const category = assignments.get(candidate.item.externalId);
    return category
      ? [{ ...candidate.item, signals: { ...candidate.item.signals, category } }]
      : [];
  });
}

export async function fetchArxiv(): Promise<NormalizedItem[]> {
  const all = parseFeed(await httpText(combinedFeedUrl, { timeoutMs: 25_000 }));
  if (all.length === 0) {
    console.log("[arxiv] feed 无新投稿（arxiv 周末 skipDays，工作日恢复；HF daily papers 已覆盖高分 arxiv 论文）");
  }
  return fairLimit(all, PER_SOURCE_LIMIT.arxiv);
}
