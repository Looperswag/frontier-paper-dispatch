import { httpJSON, clean } from "../../lib/http.ts";
import { LOOKBACK_DAYS, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";
import { shanghaiDateKey } from "../../lib/time.ts";
import { loadRootConfig } from "../../lib/runtime-config.ts";
import { currentRuntimeEnvironment } from "../../lib/runtime-env.ts";

interface OpenAlexWork { id?: unknown; doi?: unknown; title?: unknown; publication_date?: unknown; authorships?: unknown; cited_by_count?: unknown; primary_location?: { landing_page_url?: unknown } | null; primary_topic?: { display_name?: unknown; field?: { id?: unknown } } | null; abstract_inverted_index?: Record<string, number[]> | null; }
interface OpenAlexResponse { results: OpenAlexWork[]; }

export function validateOpenAlex(value: unknown): OpenAlexResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) {
    throw new Error("OpenAlex response must contain results");
  }
  for (const work of (value as { results: unknown[] }).results) {
    if (!work || typeof work !== "object" || Array.isArray(work)) {
      throw new Error("OpenAlex response contains an invalid work");
    }
  }
  return value as OpenAlexResponse;
}

export function openAlexWorksURL(now = new Date(), apiKey?: string): string {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid OpenAlex clock");
  const from = shanghaiDateKey(new Date(nowMs - LOOKBACK_DAYS * 86_400_000));
  const to = shanghaiDateKey(now);
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `from_publication_date:${from},to_publication_date:${to},primary_topic.subfield.id:1702`);
  url.searchParams.set("sort", "publication_date:desc");
  url.searchParams.set("per_page", String(PER_SOURCE_LIMIT.openalex));
  if (apiKey) url.searchParams.set("api_key", apiKey);
  url.searchParams.set(
    "select",
    "id,doi,title,publication_date,authorships,cited_by_count,primary_location,primary_topic,abstract_inverted_index",
  );
  return url.toString();
}

function abstract(work: OpenAlexWork): string {
  const index = work.abstract_inverted_index;
  if (!index) return "";
  return Object.entries(index)
    .flatMap(([word, positions]) => Array.isArray(positions)
      ? positions
        .filter((position) => Number.isInteger(position) && position >= 0)
        .map((position) => [position, clean(word).slice(0, 256)] as const)
      : [])
    .sort((a, b) => a[0] - b[0])
    .map(([, word]) => word)
    .join(" ")
    .slice(0, 16_384);
}

function canonicalOpenAlexURL(value: unknown): string {
  let url: URL;
  try {
    url = new URL(clean(value));
  } catch {
    return "";
  }
  const match = url.pathname.match(/^\/W(\d+)$/i);
  if (
    !match ||
    url.protocol !== "https:" ||
    url.hostname !== "openalex.org" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash
  ) return "";
  return `https://openalex.org/W${match[1]}`;
}

function canonicalDoiURL(value: unknown): string {
  let url: URL;
  try {
    url = new URL(clean(value));
  } catch {
    return "";
  }
  const doi = url.pathname.slice(1);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "doi.org" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash ||
    doi.length > 512 ||
    !/^10\.\d{4,9}\/.+$/i.test(doi)
  ) return "";
  return `https://doi.org/${doi}`;
}

function safeLandingPageURL(value: unknown): string {
  let url: URL;
  try {
    url = new URL(clean(value));
  } catch {
    return "";
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.toString().length > 2_048
  ) return "";
  url.hash = "";
  return url.toString();
}

export function mapOpenAlexWorks(response: OpenAlexResponse, now = new Date()): NormalizedItem[] {
  const from = shanghaiDateKey(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));
  const to = shanghaiDateKey(now);
  return response.results.flatMap((work) => {
    const doiURL = canonicalDoiURL(work.doi);
    const openAlexURL = canonicalOpenAlexURL(work.id);
    const id = doiURL || openAlexURL;
    const title = clean(work.title).slice(0, 1_024);
    const publishedAt = clean(work.publication_date);
    if (!id || !title || !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt) || publishedAt < from || publishedAt > to) return [];
    const authors = Array.isArray(work.authorships)
      ? work.authorships
        .flatMap((entry) => typeof entry === "object" && entry && "author" in entry && typeof entry.author === "object" && entry.author && "display_name" in entry.author ? [clean((entry.author as { display_name?: unknown }).display_name).slice(0, 256)] : [])
        .filter(Boolean)
        .slice(0, 50)
      : [];
    const rawCitations = Number(work.cited_by_count ?? 0);
    return [{
      source: "openalex",
      externalId: id,
      url: doiURL || safeLandingPageURL(work.primary_location?.landing_page_url) || openAlexURL,
      title,
      authors,
      abstract: abstract(work),
      publishedAt: `${publishedAt}T00:00:00.000Z`,
      signals: {
        sourceWeight: SOURCE_WEIGHTS.openalex,
        citations: Number.isFinite(rawCitations) && rawCitations >= 0 ? rawCitations : 0,
        category: clean(work.primary_topic?.display_name).slice(0, 256),
      },
    } satisfies NormalizedItem];
  }).slice(0, PER_SOURCE_LIMIT.openalex);
}

export async function fetchOpenAlex(): Promise<NormalizedItem[]> {
  const now = new Date();
  const apiKey = loadRootConfig("dry", currentRuntimeEnvironment()).openAlexApiKey;
  const response = await httpJSON<OpenAlexResponse>(openAlexWorksURL(now, apiKey), {
    validate: validateOpenAlex,
    headers: { "User-Agent": "frontier-paper-dispatch/0.1 (+https://github.com/Looperswag/frontier-paper-dispatch)" },
    deadlineMs: 20_000,
    maxAttempts: 2,
    maxResponseBytes: 4 * 1024 * 1024,
    redirect: "error",
    timeoutMs: 10_000,
  });
  return mapOpenAlexWorks(response, now);
}
