// Supabase 封装。动态 import，`--dry` 路径不触达数据库。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedItem, SummarizedItem } from "./types.ts";

let client: SupabaseClient | null = null;

export async function getClient(): Promise<SupabaseClient> {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（见 .env.example）");
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const row = (i: NormalizedItem) => ({
  source: i.source,
  external_id: i.externalId,
  url: i.url,
  title: i.title,
  authors: i.authors,
  abstract: i.abstract,
  content: i.content ?? null,
  published_at: i.publishedAt,
  signals: i.signals,
  raw_json: i.raw ?? null,
});

/** 落库去重：按 (source, external_id) upsert，已存在则不重复（替代 seen.json）。返回带 DB id 的映射。 */
export async function upsertItems(items: NormalizedItem[]): Promise<Map<string, string>> {
  const db = await getClient();
  const { data, error } = await db
    .from("items")
    .upsert(items.map(row), { onConflict: "source,external_id" })
    .select("id, source, external_id");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const r of data ?? []) map.set(`${r.source}:${r.external_id}`, r.id as string);
  return map;
}

export async function saveSummaries(
  items: SummarizedItem[],
  idByKey: Map<string, string>,
): Promise<void> {
  const db = await getClient();
  const rows = items.map((i) => ({
    item_id: idByKey.get(`${i.source}:${i.externalId}`),
    summary_md: i.summaryMd,
    impact_md: i.impactMd,
    one_liner: i.oneLiner,
    score: i.score,
    rank: i.rank,
    model: "claude",
  }));
  const { error } = await db.from("summaries").insert(rows);
  if (error) throw error;
}

export async function saveDigest(
  digestDate: string,
  top5: SummarizedItem[],
  idByKey: Map<string, string>,
  renderedMd: string,
): Promise<void> {
  const db = await getClient();
  const ids = top5.map((i) => idByKey.get(`${i.source}:${i.externalId}`)).filter(Boolean);
  const { error } = await db
    .from("digests")
    .upsert(
      { digest_date: digestDate, top5_item_ids: ids, rendered_md: renderedMd, emailed_at: new Date().toISOString() },
      { onConflict: "digest_date" },
    );
  if (error) throw error;
}
