import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shanghaiDateKey } from "@/lib/time";
import { getDataConfig } from "@/lib/config.server";
import type { OwnerContext } from "@/lib/auth";
import type { VerifiedFeedbackTokenClaims } from "@/lib/feedback-token";
import {
  feedbackTokenFingerprint,
  isVerifiedFeedbackTokenClaims,
} from "@/lib/feedback-token";
import {
  isAnnotationAnchor,
  type AnnotationType,
} from "@/lib/annotation-anchor";
import {
  assertDatabaseIntegrity,
  databaseData,
  DatabaseNotFoundError,
  isDatabaseUuid,
} from "@/lib/db-result";

// 服务端专用：admin client 只在已验证 owner capability 到达 DAL 后惰性创建。
let db: SupabaseClient;

function activateDatabase(owner: OwnerContext): void {
  void owner;
  if (db) return;
  const config = getDataConfig();
  db = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false } });
}

export interface Item {
  id: string;
  source: string;
  external_id: string;
  url: string;
  title: string;
  authors: string[];
  abstract: string;
  published_at: string;
  signals: Record<string, number | string>;
}
export interface Summary {
  one_liner: string;
  summary_md: string;
  impact_md: string;
  score: number;
  rank: number;
}
export interface Paper extends Item {
  summary?: Summary;
  rating?: "up" | "down" | null;
}

function recordValue(operation: string, value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity(
    operation,
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function canonicalDatabaseUuid(operation: string, value: unknown): string {
  assertDatabaseIntegrity(operation, isDatabaseUuid(value));
  return value.toLowerCase();
}

function isDateKey(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  ) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

function isDatabaseTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match || !isDateKey(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    !Number.isNaN(Date.parse(value))
  );
}

function timestampMicros(value: string): bigint {
  const fractional = value.match(/\.(\d{1,6})(?:Z|[+-])/i)?.[1] ?? "";
  const microseconds = fractional.padEnd(6, "0");
  const belowMillisecond = microseconds.slice(3);
  return BigInt(Date.parse(value)) * BigInt(1_000) + BigInt(belowMillisecond || "0");
}

function isStableHistoryOrder(
  rows: ReadonlyArray<{ created_at: string; id: string }>,
  ascending: boolean,
): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const previousTime = timestampMicros(previous.created_at);
    const currentTime = timestampMicros(current.created_at);
    if (previousTime === currentTime) {
      if (ascending ? previous.id > current.id : previous.id < current.id) return false;
    } else if (ascending ? previousTime > currentTime : previousTime < currentTime) {
      return false;
    }
  }
  return true;
}

function itemRow(operation: string, value: unknown): Item {
  const row = recordValue(operation, value);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.id) &&
      typeof row.source === "string" &&
      typeof row.external_id === "string" &&
      typeof row.url === "string" &&
      typeof row.title === "string" &&
      Array.isArray(row.authors) &&
      row.authors.every((author) => typeof author === "string") &&
      typeof row.abstract === "string" &&
      typeof row.published_at === "string" &&
      row.signals !== null &&
      typeof row.signals === "object" &&
      !Array.isArray(row.signals),
  );
  return row as unknown as Item;
}

function exactItems(operation: string, data: unknown, expectedIds: readonly string[]): Item[] {
  assertDatabaseIntegrity(operation, Array.isArray(data));
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const items = data.map((value) => {
    const item = itemRow(operation, value);
    assertDatabaseIntegrity(operation, expected.has(item.id) && !seen.has(item.id));
    seen.add(item.id);
    return item;
  });
  assertDatabaseIntegrity(
    operation,
    seen.size === expected.size && [...expected].every((id) => seen.has(id)),
  );
  return items;
}

function summaryRow(operation: string, value: unknown): Summary & { item_id: string } {
  const row = recordValue(operation, value);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.item_id) &&
      typeof row.one_liner === "string" &&
      typeof row.summary_md === "string" &&
      typeof row.impact_md === "string" &&
      typeof row.score === "number" &&
      Number.isInteger(row.score) &&
      row.score >= 0 &&
      row.score <= 100 &&
      typeof row.rank === "number" &&
      Number.isInteger(row.rank) &&
      row.rank > 0,
  );
  return row as unknown as Summary & { item_id: string };
}

type HistoricalSummary = Summary & {
  created_at: string;
  id: string;
  item_id: string;
};

function historicalSummaryRow(operation: string, value: unknown): HistoricalSummary {
  const summary = summaryRow(operation, value);
  const row = recordValue(operation, value);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.id) && isDatabaseTimestamp(row.created_at),
  );
  return {
    ...summary,
    created_at: row.created_at,
    id: row.id,
  };
}

async function latestSummary(itemId: string): Promise<Summary | undefined> {
  const data = databaseData(
    "summaries.fetchLatest",
    await db
      .from("summaries")
      .select("id, item_id, one_liner, summary_md, impact_md, score, rank, created_at")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  if (data === null) return undefined;
  const summary = historicalSummaryRow("summaries.fetchLatest", data);
  assertDatabaseIntegrity("summaries.fetchLatest", summary.item_id === itemId);
  return summary;
}

/** 回填每篇当前的反馈状态（👍/👎）。 */
async function attachRatings(papers: Paper[]): Promise<Paper[]> {
  if (!papers.length) return papers;
  const expected = new Set(papers.map((paper) => paper.id));
  const data = databaseData(
    "feedback.attach",
    await db
      .from("feedback")
      .select("item_id, rating")
      .in("item_id", [...expected]),
  );
  assertDatabaseIntegrity("feedback.attach", Array.isArray(data));
  const m = new Map<string, "up" | "down">();
  for (const value of data) {
    const row = recordValue("feedback.attach", value);
    assertDatabaseIntegrity(
      "feedback.attach",
      isDatabaseUuid(row.item_id) &&
        expected.has(row.item_id) &&
        !m.has(row.item_id) &&
        (row.rating === "up" || row.rating === "down"),
    );
    m.set(row.item_id, row.rating);
  }
  return papers.map((p) => ({ ...p, rating: (m.get(p.id) as "up" | "down" | undefined) ?? null }));
}

/** 记录/更新一篇的反馈（网页内打分用；一篇一条 upsert）。 */
export async function saveFeedback(
  owner: OwnerContext,
  itemId: string,
  rating: "up" | "down",
  note?: string | null,
  occurredAt: Date = new Date(),
): Promise<void> {
  const operation = "feedback.upsert";
  const validNote =
    note === undefined ||
    note === null ||
    (typeof note === "string" &&
      note === note.trim() &&
      [...note].length >= 1 &&
      [...note].length <= 500 &&
      new TextEncoder().encode(note).byteLength <= 2_048);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(itemId) &&
      (rating === "up" || rating === "down") &&
      validNote &&
      occurredAt instanceof Date &&
      Number.isFinite(occurredAt.valueOf()),
  );
  activateDatabase(owner);
  const canonicalItemId = canonicalDatabaseUuid(operation, itemId);
  const payload = {
    digest_date: shanghaiDateKey(occurredAt),
    item_id: canonicalItemId,
    note: note ?? null,
    rating,
  };
  const data = databaseData(
    operation,
    await db
      .from("feedback")
      .upsert(payload, { onConflict: "item_id" })
      .select("id, item_id, rating, note, digest_date, created_at")
      .single(),
  );
  const row = recordValue(operation, data);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.id) &&
      row.item_id === payload.item_id &&
      row.rating === payload.rating &&
      row.note === payload.note &&
      row.digest_date === payload.digest_date &&
      isDatabaseTimestamp(row.created_at),
  );
}

export type FeedbackRedemptionResult =
  | Readonly<{
      digestDate: string;
      feedbackId: string;
      itemId: string;
      ok: true;
      rating: "up" | "down";
      redeemedAt: string;
    }>
  | Readonly<{
      ok: false;
      reason: "already_redeemed" | "expired" | "invalid_context";
    }>;

function isCanonicalFeedbackNonce(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function isRedeemableFeedbackClaims(value: unknown): value is VerifiedFeedbackTokenClaims {
  if (!isVerifiedFeedbackTokenClaims(value)) return false;
  const claims = value;
  return (
    Object.keys(value).sort().join(",") ===
      "digestDate,expiresAt,itemId,nonce,rating,version" &&
    claims.version === "v1" &&
    isDateKey(claims.digestDate) &&
    isDatabaseUuid(claims.itemId) &&
    claims.itemId === claims.itemId.toLowerCase() &&
    (claims.rating === "up" || claims.rating === "down") &&
    Number.isSafeInteger(claims.expiresAt) &&
    (claims.expiresAt ?? 0) > 0 &&
    (claims.expiresAt ?? 0) <= 253_402_300_799 &&
    isCanonicalFeedbackNonce(claims.nonce)
  );
}

/** Atomically consumes a previously verified one-time feedback token. */
export async function redeemFeedbackToken(
  owner: OwnerContext,
  claims: VerifiedFeedbackTokenClaims,
): Promise<FeedbackRedemptionResult> {
  const operation = "feedback.redeem";
  assertDatabaseIntegrity(operation, isRedeemableFeedbackClaims(claims));
  activateDatabase(owner);
  const expiresAt = new Date(claims.expiresAt * 1_000).toISOString();
  const data = databaseData(
    operation,
    await db.rpc("redeem_feedback_token", {
      p_digest_date: claims.digestDate,
      p_expires_at: expiresAt,
      p_item_id: claims.itemId,
      p_nonce_hash: feedbackTokenFingerprint(claims.nonce),
      p_rating: claims.rating,
      p_token_version: 1,
    }),
  );
  assertDatabaseIntegrity(operation, Array.isArray(data) && data.length === 1);
  const row = recordValue(operation, data[0]);
  const outcome = row.outcome;
  if (
    outcome === "already_redeemed" ||
    outcome === "expired" ||
    outcome === "invalid_context"
  ) {
    assertDatabaseIntegrity(
      operation,
      row.feedback_id === null &&
        row.persisted_item_id === null &&
        row.persisted_digest_date === null &&
        row.persisted_rating === null &&
        row.redeemed_at === null,
    );
    return Object.freeze({ ok: false, reason: outcome });
  }
  assertDatabaseIntegrity(
    operation,
    outcome === "recorded" &&
      isDatabaseUuid(row.feedback_id) &&
      row.persisted_item_id === claims.itemId &&
      row.persisted_digest_date === claims.digestDate &&
      row.persisted_rating === claims.rating &&
      isDatabaseTimestamp(row.redeemed_at) &&
      Date.parse(row.redeemed_at) < claims.expiresAt * 1_000,
  );
  return Object.freeze({
    digestDate: claims.digestDate,
    feedbackId: row.feedback_id as string,
    itemId: claims.itemId,
    ok: true,
    rating: claims.rating,
    redeemedAt: row.redeemed_at as string,
  });
}

/** 最新一期 digest 的 Top5（按 rank 排序）。 */
export async function getTop5(owner: OwnerContext): Promise<{ date: string | null; papers: Paper[] }> {
  const operation = "digests.fetchTop5";
  activateDatabase(owner);
  const data = databaseData(
    operation,
    await db.rpc("get_latest_digest_bundle"),
  );
  assertDatabaseIntegrity(operation, Array.isArray(data));
  if (data.length === 0) return { date: null, papers: [] };
  assertDatabaseIntegrity(operation, data.length === 1);
  const digestRow = recordValue(operation, data[0]);
  assertDatabaseIntegrity(
    operation,
    isDateKey(digestRow.digest_date) &&
      Array.isArray(digestRow.top5_item_ids) &&
      digestRow.top5_item_ids.length >= 1 &&
      digestRow.top5_item_ids.length <= 5 &&
      digestRow.top5_item_ids.every(isDatabaseUuid) &&
      new Set(digestRow.top5_item_ids).size === digestRow.top5_item_ids.length &&
      Array.isArray(digestRow.papers) &&
      digestRow.papers.length === digestRow.top5_item_ids.length,
  );
  const digestIds = digestRow.top5_item_ids as string[];
  const papers = (digestRow.papers as unknown[]).map((value, index) => {
    const row = recordValue(operation, value);
    const item = itemRow(operation, row);
    const summary = summaryRow(operation, row);
    assertDatabaseIntegrity(
      operation,
      item.id === digestIds[index] &&
        summary.item_id === item.id &&
        summary.rank === index + 1 &&
        (row.rating === null || row.rating === "up" || row.rating === "down"),
    );
    return {
      ...item,
      rating: row.rating as "up" | "down" | null,
      summary: {
        impact_md: summary.impact_md,
        one_liner: summary.one_liner,
        rank: summary.rank,
        score: summary.score,
        summary_md: summary.summary_md,
      },
    };
  });
  return { date: digestRow.digest_date as string, papers };
}

/** 单篇（含最新摘要）。 */
export async function getPaper(owner: OwnerContext, id: string): Promise<Paper | null> {
  const canonicalId = canonicalDatabaseUuid("items.fetchOne", id);
  activateDatabase(owner);
  const data = databaseData(
    "items.fetchOne",
    await db.from("items").select("*").eq("id", canonicalId).maybeSingle(),
  );
  if (data === null) return null;
  const item = itemRow("items.fetchOne", data);
  assertDatabaseIntegrity("items.fetchOne", item.id === canonicalId);
  const summary = await latestSummary(item.id);
  const p: Paper = { ...item, ...(summary ? { summary } : {}) };
  const [withRating] = await attachRatings([p]);
  return withRating;
}

/** 左栏归档：所有有摘要的论文，最近优先。 */
export async function listArchive(owner: OwnerContext, limit = 60): Promise<Paper[]> {
  assertDatabaseIntegrity(
    "summaries.listArchive",
    Number.isInteger(limit) && limit >= 1 && limit <= 500,
  );
  activateDatabase(owner);
  const pageSize = Math.max(100, Math.min(1_000, limit * 2));
  const newestByItem = new Map<string, HistoricalSummary>();
  const seenSummaryIds = new Set<string>();
  let offset = 0;
  while (newestByItem.size < limit) {
    const batch = databaseData(
      "summaries.listArchive",
      await db
        .from("summaries")
        .select("id, item_id, one_liner, summary_md, impact_md, score, rank, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + pageSize - 1),
    );
    assertDatabaseIntegrity("summaries.listArchive", Array.isArray(batch));
    for (const value of batch) {
      const summary = historicalSummaryRow("summaries.listArchive", value);
      assertDatabaseIntegrity("summaries.listArchive", !seenSummaryIds.has(summary.id));
      seenSummaryIds.add(summary.id);
      if (!newestByItem.has(summary.item_id)) newestByItem.set(summary.item_id, summary);
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  const parsedSummaries = [...newestByItem.values()].slice(0, limit);
  const ids = parsedSummaries.map((summary) => summary.item_id);
  if (!ids.length) return [];
  const items = databaseData(
    "items.listArchive",
    await db.from("items").select("*").in("id", ids),
  );
  const byId = new Map(
    exactItems("items.listArchive", items, ids).map((item) => [item.id, item]),
  );
  const seen = new Set<string>();
  const out: Paper[] = [];
  for (const summary of parsedSummaries) {
    if (seen.has(summary.item_id)) continue;
    seen.add(summary.item_id);
    out.push({ ...(byId.get(summary.item_id) as Item), summary });
  }
  return out;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

type HistoricalChat = ChatMsg & {
  created_at: string;
  id: string;
  item_id: string;
};

function historicalChatRow(operation: string, itemId: string, value: unknown): HistoricalChat {
  const row = recordValue(operation, value);
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.id) &&
      isDatabaseUuid(row.item_id) &&
      row.item_id === itemId &&
      (row.role === "user" || row.role === "assistant") &&
      typeof row.content === "string" &&
      isDatabaseTimestamp(row.created_at),
  );
  return row as unknown as HistoricalChat;
}

/** 某篇论文的历史对话（按时间正序）。 */
export async function getChats(owner: OwnerContext, itemId: string): Promise<ChatMsg[]> {
  const operation = "chats.fetchHistory";
  const canonicalItemId = canonicalDatabaseUuid(operation, itemId);
  activateDatabase(owner);
  const data = databaseData(
    operation,
    await db
      .from("chats")
      .select("id, item_id, role, content, created_at")
      .eq("item_id", canonicalItemId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(60),
  );
  assertDatabaseIntegrity(operation, Array.isArray(data) && data.length <= 60);
  const seen = new Set<string>();
  const newestFirst = data.map((value) => {
    const row = historicalChatRow(operation, canonicalItemId, value);
    assertDatabaseIntegrity(operation, !seen.has(row.id));
    seen.add(row.id);
    return row;
  });
  assertDatabaseIntegrity(operation, isStableHistoryOrder(newestFirst, false));
  return newestFirst.reverse().map(({ content, role }) => ({ content, role }));
}

export async function saveChat(
  owner: OwnerContext,
  itemId: string,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const operation = "chats.insert";
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(itemId) &&
      (role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.length > 0,
  );
  activateDatabase(owner);
  const canonicalItemId = canonicalDatabaseUuid(operation, itemId);
  const data = databaseData(
    operation,
    await db
      .from("chats")
      .insert({ item_id: canonicalItemId, role, content })
      .select("id, item_id, role, content, created_at")
      .single(),
  );
  const row = historicalChatRow(operation, canonicalItemId, data);
  assertDatabaseIntegrity(operation, row.role === role && row.content === content);
}

export type AnnoType = AnnotationType;
export interface Annotation {
  id: string;
  type: AnnoType;
  anchor: unknown; // highlight:{rects} pen:{points} box:{x,y,w,h} note:{x,y}
  color: string;
  body: string | null;
}

type HistoricalAnnotation = Annotation & {
  created_at: string;
  item_id: string;
};

function isAnchorRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => isJsonEqual(value, right[index]))
    );
  }
  if (!isAnchorRecord(left) || !isAnchorRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && isJsonEqual(left[key], right[key]),
    )
  );
}

function historicalAnnotationRow(
  operation: string,
  itemId: string,
  value: unknown,
): HistoricalAnnotation {
  const row = recordValue(operation, value);
  const type = row.type;
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(row.id) &&
      isDatabaseUuid(row.item_id) &&
      row.item_id === itemId &&
      (type === "highlight" || type === "note" || type === "pen" || type === "box") &&
      isAnnotationAnchor(type, row.anchor) &&
      typeof row.color === "string" &&
      /^#[0-9a-f]{6}$/i.test(row.color) &&
      (row.body === null || typeof row.body === "string") &&
      isDatabaseTimestamp(row.created_at),
  );
  return row as unknown as HistoricalAnnotation;
}

export async function getAnnotations(owner: OwnerContext, itemId: string): Promise<Annotation[]> {
  const operation = "annotations.fetchForItem";
  const canonicalItemId = canonicalDatabaseUuid(operation, itemId);
  activateDatabase(owner);
  const data = databaseData(
    operation,
    await db
      .from("annotations")
      .select("id, item_id, type, anchor, color, body, created_at")
      .eq("item_id", canonicalItemId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
  assertDatabaseIntegrity(operation, Array.isArray(data));
  const seen = new Set<string>();
  const rows = data.map((value) => {
    const row = historicalAnnotationRow(operation, canonicalItemId, value);
    assertDatabaseIntegrity(operation, !seen.has(row.id));
    seen.add(row.id);
    return row;
  });
  assertDatabaseIntegrity(operation, isStableHistoryOrder(rows, true));
  return rows.map((row) => {
    const { anchor, body, color, id, type } = row;
    return { anchor, body, color, id, type };
  });
}

export async function addAnnotation(
  owner: OwnerContext,
  itemId: string,
  type: AnnoType,
  anchor: unknown,
  color: string,
  body: string | null,
): Promise<Annotation> {
  const operation = "annotations.insert";
  assertDatabaseIntegrity(
    operation,
    isDatabaseUuid(itemId) &&
      (type === "highlight" || type === "note" || type === "pen" || type === "box") &&
      isAnnotationAnchor(type, anchor) &&
      typeof color === "string" &&
      /^#[0-9a-f]{6}$/i.test(color) &&
      (body === null || typeof body === "string"),
  );
  activateDatabase(owner);
  const canonicalItemId = canonicalDatabaseUuid(operation, itemId);
  const data = databaseData(
    operation,
    await db
      .from("annotations")
      .insert({ item_id: canonicalItemId, type, anchor, color, body })
      .select("id, item_id, type, anchor, color, body, created_at")
      .single(),
  );
  const row = historicalAnnotationRow(operation, canonicalItemId, data);
  assertDatabaseIntegrity(
    operation,
    row.type === type &&
      isJsonEqual(row.anchor, anchor) &&
      row.color === color &&
      row.body === body,
  );
  const { id, type: storedType, anchor: storedAnchor, color: storedColor, body: storedBody } = row;
  return {
    anchor: storedAnchor,
    body: storedBody,
    color: storedColor,
    id,
    type: storedType,
  };
}

export async function deleteAnnotation(owner: OwnerContext, id: string): Promise<void> {
  const operation = "annotations.delete";
  const canonicalId = canonicalDatabaseUuid(operation, id);
  activateDatabase(owner);
  const data = databaseData(
    operation,
    await db.from("annotations").delete().eq("id", canonicalId).select("id"),
  );
  assertDatabaseIntegrity(operation, Array.isArray(data));
  if (data.length === 0) throw new DatabaseNotFoundError(operation);
  assertDatabaseIntegrity(operation, data.length === 1);
  const row = recordValue(operation, data[0]);
  assertDatabaseIntegrity(operation, row.id === canonicalId);
}

/** 跨库检索：在所有"已收录(有摘要)"论文的 标题/摘要/概要/影响 上做 AND 关键词匹配。
 *  当前语料规模下 JS 过滤足够；上千篇时再上 Postgres FTS 索引（ponytail）。 */
export async function searchPapers(owner: OwnerContext, q: string): Promise<Paper[]> {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const all = await listArchive(owner, 500);
  return all.filter((p) => {
    const hay = `${p.title} ${p.abstract} ${p.summary?.one_liner ?? ""} ${p.summary?.summary_md ?? ""} ${p.summary?.impact_md ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
