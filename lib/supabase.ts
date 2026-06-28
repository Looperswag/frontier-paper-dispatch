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
    model: "deepseek",
  }));
  // 同日/重跑时替换这些 item 的旧摘要，避免每篇堆叠多条。
  const ids = rows.map((r) => r.item_id).filter(Boolean) as string[];
  if (ids.length) await db.from("summaries").delete().in("item_id", ids);
  const { error } = await db.from("summaries").insert(rows);
  if (error) throw error;
}

/** 取用户的行为信号：带正文的批注（高亮引文/便签想法）+ 提问，用于画像精炼。 */
export async function fetchSignals(): Promise<{
  annotations: { type: string; body: string; title: string }[];
  chats: { content: string; title: string }[];
}> {
  const db = await getClient();
  const { data: a } = await db
    .from("annotations")
    .select("type, body, items(title)")
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  const { data: c } = await db
    .from("chats")
    .select("content, items(title)")
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(200);
  const title = (x: any): string =>
    Array.isArray(x?.items) ? x.items[0]?.title ?? "" : x?.items?.title ?? "";
  return {
    annotations: (a ?? []).map((x: any) => ({ type: x.type, body: x.body, title: title(x) })),
    chats: (c ?? []).map((x: any) => ({ content: x.content, title: title(x) })),
  };
}

/** 近 days 天的 Top5 反馈（含标题/来源/分类/理由），喂给排名与画像精炼。 */
export async function fetchFeedback(
  days = 21,
): Promise<{ rating: string; note: string | null; title: string; source: string; category: string }[]> {
  const db = await getClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await db
    .from("feedback")
    .select("rating, note, created_at, items(title, source, signals)")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  const item = (x: any) => (Array.isArray(x?.items) ? x.items[0] : x?.items) ?? {};
  return (data ?? []).map((x: any) => {
    const it = item(x);
    return {
      rating: x.rating,
      note: x.note,
      title: it.title ?? "",
      source: it.source ?? "",
      category: String(it.signals?.category ?? ""),
    };
  });
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
