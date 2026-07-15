// Supabase 封装。动态 import，`--dry` 路径不触达数据库。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedItem, SummarizedItem } from "./types.ts";
import { assertDatabaseIntegrity, databaseData, isDatabaseUuid } from "./db-result.ts";
import { loadSupabaseConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment } from "./runtime-env.ts";
import {
  canonicalWorkKey,
  hasBoundedSourceIdentity,
  normalizeWorkUrl,
  sourceIdentityHash,
} from "./normalize.ts";

const clients = new WeakMap<object, SupabaseClient>();

export async function getClient(): Promise<SupabaseClient> {
  const environment = currentRuntimeEnvironment();
  const existing = clients.get(environment);
  if (existing) return existing;
  const config = loadSupabaseConfig(environment);
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false } });
  clients.set(environment, client);
  return client;
}

const row = (item: NormalizedItem) => ({
  canonical_key: canonicalWorkKey(item),
  source: item.source,
  external_id: item.externalId,
  url: item.url,
  title: item.title,
  authors: item.authors,
  abstract: item.abstract,
  content: item.content ?? null,
  published_at: item.publishedAt,
  signals: item.signals,
  provenance: item.provenance?.length
    ? item.provenance
    : [{
        source: item.source,
        externalId: item.externalId,
        url: normalizeWorkUrl(item.url) || item.url,
        signals: item.signals,
      }],
  raw_json: item.raw ?? null,
});

function mappedItemIds(
  operation: string,
  items: readonly NormalizedItem[],
  idByKey: ReadonlyMap<string, string>,
): string[] {
  const keys = new Set<string>();
  const ids = new Set<string>();
  const mapped: string[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.externalId}`;
    const id = idByKey.get(key);
    assertDatabaseIntegrity(
      operation,
      !keys.has(key) && isDatabaseUuid(id) && !ids.has(id),
    );
    keys.add(key);
    ids.add(id);
    mapped.push(id);
  }
  return mapped;
}

function recordValue(operation: string, value: unknown): Record<string, unknown> {
  assertDatabaseIntegrity(
    operation,
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function relatedRecord(operation: string, value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    assertDatabaseIntegrity(operation, value.length === 1);
  }
  const related = Array.isArray(value) ? value[0] : value;
  return recordValue(operation, related);
}

function relatedTitle(operation: string, value: unknown): string {
  const title = relatedRecord(operation, value).title;
  assertDatabaseIntegrity(operation, typeof title === "string");
  return title;
}

export interface PipelineItemOwner {
  runDate: string;
  runId: string;
}

/** Persist one row per canonical work and map every incoming source identity to that row. */
export async function upsertItems(
  items: NormalizedItem[],
  pipelineOwner?: PipelineItemOwner,
): Promise<Map<string, string>> {
  if (!items.length) return new Map();
  const expected = new Set(items.map((item) => `${item.source}:${item.externalId}`));
  const canonicalKeys = new Set(items.map(canonicalWorkKey));
  const sourceIdentities = new Set(items.map((item) => sourceIdentityHash(item.source, item.externalId)));
  assertDatabaseIntegrity(
    "items.upsert",
    expected.size === items.length &&
      canonicalKeys.size === items.length &&
      sourceIdentities.size === items.length &&
      items.every(hasBoundedSourceIdentity) &&
      (pipelineOwner === undefined || (
        /^\d{4}-\d{2}-\d{2}$/.test(pipelineOwner.runDate) &&
        isDatabaseUuid(pipelineOwner.runId)
      )),
  );
  const db = await getClient();
  const rows = items.map(row);
  let result;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = pipelineOwner
      ? await db.rpc("upsert_pipeline_items", {
          p_items: rows,
          p_run_date: pipelineOwner.runDate,
          p_run_id: pipelineOwner.runId,
        })
      : await db
          .from("items")
          .upsert(rows, { onConflict: "canonical_key" })
          .select("id, canonical_key, source, external_id");
    const errorCode = result.error && typeof result.error === "object" && "code" in result.error
      ? String(result.error.code)
      : "";
    if (!result.error || attempt === 2 || (errorCode !== "23505" && errorCode !== "40001")) break;
  }
  assertDatabaseIntegrity("items.upsert", result !== undefined);
  const data = databaseData("items.upsert", result);
  assertDatabaseIntegrity("items.upsert", Array.isArray(data));
  const map = new Map<string, string>();
  const returnedIds = new Set<string>();
  for (const record of data) {
    const canonicalKey = record?.canonical_key;
    const id = record?.id;
    const returnedSourceKey = typeof record?.source === "string" && typeof record?.external_id === "string"
      ? `${record.source}:${record.external_id}`
      : undefined;
    const incoming = returnedSourceKey && expected.has(returnedSourceKey)
      ? items.find((item) => `${item.source}:${item.externalId}` === returnedSourceKey)
      : items.find((item) => canonicalWorkKey(item) === canonicalKey);
    assertDatabaseIntegrity(
      "items.upsert",
      typeof canonicalKey === "string" &&
        canonicalKey.length >= 3 &&
        canonicalKey.length <= 512 &&
        isDatabaseUuid(id) &&
        !returnedIds.has(id),
    );
    assertDatabaseIntegrity("items.upsert", incoming !== undefined);
    const sourceKey = `${incoming.source}:${incoming.externalId}`;
    assertDatabaseIntegrity("items.upsert", expected.has(sourceKey) && !map.has(sourceKey));
    map.set(sourceKey, id);
    returnedIds.add(id);
  }
  assertDatabaseIntegrity(
    "items.upsert",
    map.size === expected.size && [...expected].every((key) => map.has(key)),
  );
  return map;
}

/** 取用户的行为信号：带正文的批注（高亮引文/便签想法）+ 提问，用于画像精炼。 */
export async function fetchSignals(): Promise<{
  annotations: { type: string; body: string; title: string }[];
  chats: { content: string; title: string }[];
}> {
  const db = await getClient();
  const a = databaseData(
    "annotations.fetchSignals",
    await db
      .from("annotations")
      .select("type, body, items(title)")
      .not("body", "is", null)
      .order("created_at", { ascending: false })
      .limit(200),
  );
  assertDatabaseIntegrity("annotations.fetchSignals", Array.isArray(a));
  const annotations = a.map((value) => {
    const record = recordValue("annotations.fetchSignals", value);
    assertDatabaseIntegrity(
      "annotations.fetchSignals",
      typeof record.type === "string" && typeof record.body === "string",
    );
    return {
      type: record.type,
      body: record.body,
      title: relatedTitle("annotations.fetchSignals", record.items),
    };
  });
  const c = databaseData(
    "chats.fetchSignals",
    await db
      .from("chats")
      .select("content, items(title)")
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(200),
  );
  assertDatabaseIntegrity("chats.fetchSignals", Array.isArray(c));
  const chats = c.map((value) => {
    const record = recordValue("chats.fetchSignals", value);
    assertDatabaseIntegrity("chats.fetchSignals", typeof record.content === "string");
    return {
      content: record.content,
      title: relatedTitle("chats.fetchSignals", record.items),
    };
  });
  return {
    annotations,
    chats,
  };
}

/** 近 days 天的 Top5 反馈（含标题/来源/分类/理由），喂给排名与画像精炼。 */
export async function fetchFeedback(
  days = 21,
): Promise<{ rating: string; note: string | null; title: string; source: string; category: string }[]> {
  const db = await getClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const data = databaseData(
    "feedback.fetchRecent",
    await db
      .from("feedback")
      .select("rating, note, created_at, items(title, source, signals)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
  );
  assertDatabaseIntegrity("feedback.fetchRecent", Array.isArray(data));
  return data.map((value) => {
    const record = recordValue("feedback.fetchRecent", value);
    assertDatabaseIntegrity(
      "feedback.fetchRecent",
      (record.rating === "up" || record.rating === "down") &&
        (record.note === null || typeof record.note === "string"),
    );
    const item = relatedRecord("feedback.fetchRecent", record.items);
    assertDatabaseIntegrity(
      "feedback.fetchRecent",
      typeof item.title === "string" &&
        typeof item.source === "string" &&
        item.signals !== null &&
        typeof item.signals === "object" &&
        !Array.isArray(item.signals),
    );
    const category = (item.signals as Record<string, unknown>).category;
    assertDatabaseIntegrity(
      "feedback.fetchRecent",
      category === undefined || typeof category === "string" || typeof category === "number",
    );
    return {
      rating: record.rating,
      note: record.note,
      title: item.title,
      source: item.source,
      category: category === undefined ? "" : String(category),
    };
  });
}

/** Remove items already shown in recent Top5 digests without changing identity. */
export async function filterRecentlyDelivered(
  items: readonly NormalizedItem[],
  days = 14,
  now = new Date(),
): Promise<NormalizedItem[]> {
  if (!items.length) return [];
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid novelty lookback");
  const from = new Date(now.getTime() - days * 86_400_000);
  const db = await getClient();
  const delivered = databaseData(
    "novelty.successfulDeliveries",
    await db.rpc("successful_delivery_canonical_keys", {
      p_since: from.toISOString(),
      p_until: now.toISOString(),
    }),
  );
  assertDatabaseIntegrity("novelty.successfulDeliveries", Array.isArray(delivered));
  const keys = new Set<string>();
  const identities = new Set<string>();
  for (const value of delivered) {
    const record = recordValue("novelty.successfulDeliveries", value);
    assertDatabaseIntegrity(
      "novelty.successfulDeliveries",
      typeof record.canonical_key === "string" &&
        record.canonical_key.length >= 3 &&
        record.canonical_key.length <= 512 &&
        typeof record.identity_hash === "string" &&
        /^[a-f0-9]{64}$/.test(record.identity_hash),
    );
    keys.add(record.canonical_key);
    identities.add(record.identity_hash);
  }
  return items.filter((item) =>
    !keys.has(canonicalWorkKey(item)) &&
    !identities.has(sourceIdentityHash(item.source, item.externalId)),
  );
}

/** 把反馈数组拼成给 LLM 的简短摘要（喜欢/不喜欢两列）。 */
export function feedbackSummary(
  fb: { rating: string; note: string | null; title: string; source: string; category: string }[],
): string {
  if (!fb.length) return "";
  const line = (f: (typeof fb)[number]) =>
    `《${f.title}》[${f.source}${f.category ? "/" + f.category : ""}]${f.note ? `（${f.note}）` : ""}`;
  const up = fb.filter((f) => f.rating === "up").map(line);
  const down = fb.filter((f) => f.rating === "down").map(line);
  return [up.length ? `👍 喜欢：${up.join("；")}` : "", down.length ? `👎 不喜欢：${down.join("；")}` : ""]
    .filter(Boolean)
    .join("\n");
}

export async function saveDigest(
  digestDate: string,
  top5: SummarizedItem[],
  idByKey: Map<string, string>,
  renderedMd: string,
  pipelineRunId?: string,
): Promise<void> {
  const validInteger = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2_147_483_648 &&
    value <= 2_147_483_647;
  assertDatabaseIntegrity(
    "digests.save",
    top5.length >= 1 &&
      top5.length <= 5 &&
      typeof renderedMd === "string" &&
      Buffer.byteLength(renderedMd, "utf8") >= 1 &&
      Buffer.byteLength(renderedMd, "utf8") <= 1_048_576 &&
      top5.every(
        (item, index) =>
          typeof item.oneLiner === "string" &&
          typeof item.summaryMd === "string" &&
          typeof item.impactMd === "string" &&
          validInteger(item.score) &&
          item.score >= 0 &&
          item.score <= 100 &&
          validInteger(item.rank) &&
          item.rank === index + 1,
      ) &&
      (pipelineRunId === undefined || isDatabaseUuid(pipelineRunId)),
  );
  const ids = mappedItemIds("digests.save", top5, idByKey);
  const db = await getClient();
  const saved = databaseData(
    "digests.save",
    await db.rpc(pipelineRunId ? "store_pipeline_digest_bundle" : "store_digest_bundle", {
      p_digest_date: digestDate,
      p_impact_mds: top5.map((item) => item.impactMd),
      p_item_ids: ids,
      p_one_liners: top5.map((item) => item.oneLiner),
      p_ranks: top5.map((item) => item.rank),
      p_rendered_md: renderedMd,
      p_scores: top5.map((item) => item.score),
      p_summary_mds: top5.map((item) => item.summaryMd),
      ...(pipelineRunId ? { p_run_id: pipelineRunId } : {}),
    }),
  );
  assertDatabaseIntegrity("digests.save", Array.isArray(saved) && saved.length === 1);
  const record = recordValue("digests.save", saved[0]);
  assertDatabaseIntegrity(
    "digests.save",
    (record.outcome === "inserted" || record.outcome === "existing") &&
      record.persisted_digest_date === digestDate &&
      record.persisted_rendered_md === renderedMd &&
      record.persisted_summary_count === ids.length &&
      Array.isArray(record.persisted_top5_item_ids) &&
      record.persisted_top5_item_ids.length === ids.length &&
      record.persisted_top5_item_ids.every((id, index) => id === ids[index]),
  );
}
