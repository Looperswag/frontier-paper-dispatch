import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ACL_SELECTED_VENUES, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import { clean, httpText } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import type { NormalizedItem } from "../../lib/types.ts";

export const ACL_ANTHOLOGY_FEED_URL = "https://aclanthology.org/papers/index.xml";

interface AclFeedItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
  description?: unknown;
}

export interface AclAnthologyFeed {
  items: AclFeedItem[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const selectedVenues = new Set<string>(ACL_SELECTED_VENUES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return clean((value as Record<string, unknown>)["#text"] ?? "");
  }
  return clean(value);
}

export function parseAclAnthologyFeed(xml: string): AclAnthologyFeed {
  if (XMLValidator.validate(xml) !== true) throw new Error("ACL Anthology feed has invalid XML");
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    throw new Error("ACL Anthology feed XML could not be parsed");
  }
  const rss = isRecord(document) ? document.rss : undefined;
  const channel = isRecord(rss) ? rss.channel : undefined;
  if (!isRecord(channel) || !Object.hasOwn(channel, "item")) {
    throw new Error("ACL Anthology feed does not match the RSS schema");
  }
  const entries = toArray<unknown>(channel.item);
  if (entries.length === 0) throw new Error("ACL Anthology RSS contains no paper entries");
  if (!entries.every((entry) =>
    isRecord(entry) &&
    Object.hasOwn(entry, "title") &&
    Object.hasOwn(entry, "link") &&
    Object.hasOwn(entry, "guid") &&
    Object.hasOwn(entry, "pubDate") &&
    Object.hasOwn(entry, "description")
  )) {
    throw new Error("ACL Anthology entry does not match the paper schema");
  }
  const items = entries as AclFeedItem[];
  return { items };
}

function paperIdentity(item: AclFeedItem): { id: string; url: string; venue: string } | undefined {
  const id = text(item.guid);
  const match = id.match(/^(\d{4})\.([a-z][a-z0-9]*)(?:[-.])[a-z0-9][a-z0-9.-]*$/i);
  if (!match || id.length > 128) return undefined;
  const venue = match[2].toLowerCase();
  if (!selectedVenues.has(venue)) return undefined;

  let url: URL;
  try {
    url = new URL(text(item.link));
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "aclanthology.org" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash ||
    url.pathname !== `/${id}/`
  ) {
    return undefined;
  }
  return { id, url: `https://aclanthology.org/${id}/`, venue };
}

function authors(description: string): string[] {
  const authorText = description.split(/\s+in\s+(?=Proceedings|Transactions|Computational Linguistics)/i, 1)[0];
  if (!authorText || authorText === description) return [];
  return authorText
    .replace(/\s+and\s+/gi, ", ")
    .split(/,\s*/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 50);
}

function fairVenueLimit(items: readonly NormalizedItem[], limit: number): NormalizedItem[] {
  const buckets = new Map<string, NormalizedItem[]>(
    ACL_SELECTED_VENUES.map((venue) => [venue, [] as NormalizedItem[]]),
  );
  for (const item of items) buckets.get(String(item.signals.venue))?.push(item);
  const result: NormalizedItem[] = [];
  while (result.length < limit) {
    let added = false;
    for (const venue of ACL_SELECTED_VENUES) {
      const next = buckets.get(venue)?.shift();
      if (!next) continue;
      result.push(next);
      added = true;
      if (result.length === limit) break;
    }
    if (!added) break;
  }
  return result;
}

export function mapAclAnthologyFeed(feed: AclAnthologyFeed): NormalizedItem[] {
  const seen = new Set<string>();
  const mapped = feed.items.flatMap((entry) => {
    const identity = paperIdentity(entry);
    const title = text(entry.title);
    const description = text(entry.description).slice(0, 2_048);
    const timestamp = Date.parse(text(entry.pubDate));
    if (!identity || !title || !Number.isFinite(timestamp) || seen.has(identity.id)) return [];
    seen.add(identity.id);
    return [{
      source: "acl",
      externalId: identity.id,
      url: identity.url,
      title: title.slice(0, 1_024),
      authors: authors(description),
      abstract: description,
      publishedAt: new Date(timestamp).toISOString(),
      signals: {
        sourceWeight: SOURCE_WEIGHTS.acl,
        venue: identity.venue,
        publisher: "ACL Anthology",
      },
    } satisfies NormalizedItem];
  });
  return fairVenueLimit(mapped, PER_SOURCE_LIMIT.acl);
}

export async function fetchACLAnthology(): Promise<NormalizedItem[]> {
  const xml = await httpText(ACL_ANTHOLOGY_FEED_URL, {
    deadlineMs: 20_000,
    maxAttempts: 2,
    maxResponseBytes: 2 * 1024 * 1024,
    redirect: "error",
    timeoutMs: 10_000,
  });
  return mapAclAnthologyFeed(parseAclAnthologyFeed(xml));
}
