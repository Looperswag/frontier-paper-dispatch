import crypto from "node:crypto";
import type { NormalizedItem, SourceObservation } from "./types.ts";

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

/** Normalize a public work URL without throwing away the work identity. */
export function normalizeWorkUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return "";
  }
}

export function sourceIdentityHash(source: string, externalId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${source.trim().toLowerCase()}\u001f${externalId.trim()}`)
    .digest("hex");
}

/** Cross-provider identity: stable public IDs first, stable source identity last. */
export function canonicalWorkKey(item: Pick<NormalizedItem, "source" | "externalId" | "url" | "title" | "authors">): string {
  const source = item.source.trim().toLowerCase();
  const externalId = item.externalId.trim();
  const lowerExternalId = externalId.toLowerCase();
  const arxivId = lowerExternalId.replace(/v\d+$/, "");
  const url = normalizeWorkUrl(item.url);
  let parsedURL: URL | undefined;
  try {
    parsedURL = url ? new URL(url) : undefined;
  } catch {
    parsedURL = undefined;
  }
  const hostname = parsedURL?.hostname.replace(/^www\./, "") ?? "";
  const trustedArxivIdentity = source === "arxiv" || source === "huggingface";
  if (trustedArxivIdentity && /^(?:\d{4}\.\d{1,5}|[a-z][a-z0-9.-]*\/\d{7})$/.test(arxivId)) {
    return `arxiv:${arxivId}`;
  }
  // URLSearchParams.get() decodes percent-encoded bytes. Keep the encoded form
  // so the browser/runtime and PostgreSQL derive the same durable identity.
  const openReview = hostname === "openreview.net"
    ? url.match(/[?&]id=([^&#]+)/i)?.[1]
    : undefined;
  if (openReview) return `openreview:${openReview}`;
  const acl = hostname === "aclanthology.org" ? parsedURL?.pathname.split("/").filter(Boolean)[0] : undefined;
  if (acl) return `acl:${acl.toLowerCase()}`;
  const doi = hostname === "doi.org" ? parsedURL?.pathname.replace(/^\//, "").match(/^(10\.\d{4,9}\/.+)$/i)?.[1] : undefined;
  if (doi) return `doi:${doi.toLowerCase()}`;
  if (/^[a-z0-9._-]+$/.test(source) && Buffer.byteLength(source, "utf8") <= 64
    && Buffer.byteLength(externalId, "utf8") >= 3
    && Buffer.byteLength(externalId, "utf8") <= 256
    && /^[a-z0-9._/-]+$/i.test(externalId)) {
    return `${source}:${externalId}`;
  }
  const prefix = /^[a-z0-9._-]+$/.test(source) && Buffer.byteLength(source, "utf8") <= 64
    ? source
    : "source";
  return `${prefix}:id:${sourceIdentityHash(source, externalId)}`;
}

/** Match the database provenance limits before one malformed source can abort a batch. */
export function hasBoundedSourceIdentity(
  item: Pick<NormalizedItem, "source" | "externalId">,
): boolean {
  const sourceBytes = Buffer.byteLength(item.source.trim(), "utf8");
  const externalIdBytes = Buffer.byteLength(item.externalId.trim(), "utf8");
  return item.source === item.source.trim().toLowerCase()
    && /^[a-z0-9._-]+$/.test(item.source)
    && sourceBytes >= 1
    && sourceBytes <= 64
    && externalIdBytes >= 1
    && externalIdBytes <= 512;
}

function merge(a: NormalizedItem, b: NormalizedItem): NormalizedItem {
  // 保留摘要更长的一条为主，合并双方 signals（保留各自数值信号如 upvotes/stars）。
  const primary = (b.abstract?.length ?? 0) > (a.abstract?.length ?? 0) ? b : a;
  const other = primary === a ? b : a;
  const observations = [...(a.provenance ?? []), ...(b.provenance ?? [])];
  const latestObservations = new Map<string, SourceObservation>();
  for (const observation of observations) {
    latestObservations.set(sourceIdentityHash(observation.source, observation.externalId), observation);
  }
  return {
    ...primary,
    abstract: primary.abstract || other.abstract,
    content: primary.content || other.content,
    signals: { ...other.signals, ...primary.signals, mergedFrom: `${a.source}+${b.source}` },
    provenance: [...latestObservations.values()],
  };
}

/** 跨源 + 源内去重：标题相同视为同一篇，合并信号。 */
export function dedupe(
  items: NormalizedItem[],
  onDiscard?: (item: NormalizedItem, reason: "empty_title" | "invalid_source_identity") => void,
): NormalizedItem[] {
  type Group = { item: NormalizedItem };
  const byCanonical = new Map<string, Group>();
  const bySourceIdentity = new Map<string, Group>();
  const groups = new Set<Group>();
  for (const it of items) {
    if (!it.title?.trim()) {
      onDiscard?.(it, "empty_title");
      continue;
    }
    if (!hasBoundedSourceIdentity(it)) {
      onDiscard?.(it, "invalid_source_identity");
      continue;
    }
    const key = canonicalWorkKey(it);
    const identity = sourceIdentityHash(it.source, it.externalId);
    const observed: SourceObservation = {
      source: it.source,
      externalId: it.externalId,
      url: normalizeWorkUrl(it.url) || it.url,
      signals: it.signals,
    };
    const item = it.provenance?.length ? it : { ...it, provenance: [observed] };
    const canonicalGroup = byCanonical.get(key);
    const identityGroup = bySourceIdentity.get(identity);
    let group = canonicalGroup ?? identityGroup;
    if (!group) {
      group = { item };
      groups.add(group);
    } else {
      group.item = merge(group.item, item);
    }

    if (canonicalGroup && identityGroup && canonicalGroup !== identityGroup) {
      canonicalGroup.item = merge(canonicalGroup.item, identityGroup.item);
      groups.delete(identityGroup);
      for (const [candidateKey, candidateGroup] of byCanonical) {
        if (candidateGroup === identityGroup) byCanonical.set(candidateKey, canonicalGroup);
      }
      for (const [candidateIdentity, candidateGroup] of bySourceIdentity) {
        if (candidateGroup === identityGroup) bySourceIdentity.set(candidateIdentity, canonicalGroup);
      }
      group = canonicalGroup;
    }
    byCanonical.set(key, group);
    bySourceIdentity.set(identity, group);
  }
  return [...groups].map((group) => group.item);
}
