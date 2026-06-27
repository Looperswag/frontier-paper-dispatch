import { createClient } from "@supabase/supabase-js";

// 服务端专用（service role key 不下发到浏览器；只在 Server Component 里调用）。
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

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
}

async function attachSummaries(items: Item[]): Promise<Paper[]> {
  if (!items.length) return [];
  const { data: sums } = await db
    .from("summaries")
    .select("item_id, one_liner, summary_md, impact_md, score, rank")
    .in("item_id", items.map((i) => i.id));
  const byItem = new Map((sums ?? []).map((s) => [s.item_id, s as Summary & { item_id: string }]));
  return items.map((it) => ({ ...it, summary: byItem.get(it.id) }));
}

/** 最新一期 digest 的 Top5（按 rank 排序）。 */
export async function getTop5(): Promise<{ date: string | null; papers: Paper[] }> {
  const { data: digest } = await db
    .from("digests")
    .select("digest_date, top5_item_ids")
    .order("digest_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!digest?.top5_item_ids?.length) return { date: null, papers: [] };
  const { data: items } = await db.from("items").select("*").in("id", digest.top5_item_ids);
  const papers = (await attachSummaries((items ?? []) as Item[])).sort(
    (a, b) => (a.summary?.rank ?? 99) - (b.summary?.rank ?? 99),
  );
  return { date: digest.digest_date as string, papers };
}

/** 单篇（含最新摘要）。 */
export async function getPaper(id: string): Promise<Paper | null> {
  const { data: it } = await db.from("items").select("*").eq("id", id).maybeSingle();
  if (!it) return null;
  const [p] = await attachSummaries([it as Item]);
  return p;
}

/** 左栏归档：所有有摘要的论文，最近优先。 */
export async function listArchive(limit = 60): Promise<Paper[]> {
  const { data: sums } = await db
    .from("summaries")
    .select("item_id, one_liner, summary_md, impact_md, score, rank, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  const ids = [...new Set((sums ?? []).map((s) => s.item_id))];
  if (!ids.length) return [];
  const { data: items } = await db.from("items").select("*").in("id", ids);
  const byId = new Map((items ?? []).map((i) => [i.id, i as Item]));
  const seen = new Set<string>();
  const out: Paper[] = [];
  for (const s of sums ?? []) {
    if (seen.has(s.item_id) || !byId.has(s.item_id)) continue;
    seen.add(s.item_id);
    out.push({ ...(byId.get(s.item_id) as Item), summary: s as Summary });
  }
  return out;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** 某篇论文的历史对话（按时间正序）。 */
export async function getChats(itemId: string): Promise<ChatMsg[]> {
  const { data } = await db
    .from("chats")
    .select("role, content")
    .eq("item_id", itemId)
    .order("created_at", { ascending: true })
    .limit(60);
  return (data ?? []) as ChatMsg[];
}

export async function saveChat(itemId: string, role: "user" | "assistant", content: string): Promise<void> {
  await db.from("chats").insert({ item_id: itemId, role, content });
}

export type AnnoType = "highlight" | "note" | "pen" | "box";
export interface Annotation {
  id: string;
  type: AnnoType;
  anchor: unknown; // highlight:{rects} pen:{points} box:{x,y,w,h} note:{x,y}
  color: string;
  body: string | null;
}

export async function getAnnotations(itemId: string): Promise<Annotation[]> {
  const { data } = await db
    .from("annotations")
    .select("id, type, anchor, color, body")
    .eq("item_id", itemId)
    .order("created_at", { ascending: true });
  return (data ?? []) as Annotation[];
}

export async function addAnnotation(
  itemId: string,
  type: AnnoType,
  anchor: unknown,
  color: string,
  body: string | null,
): Promise<Annotation> {
  const { data, error } = await db
    .from("annotations")
    .insert({ item_id: itemId, type, anchor, color, body })
    .select("id, type, anchor, color, body")
    .single();
  if (error) throw error;
  return data as Annotation;
}

export async function deleteAnnotation(id: string): Promise<void> {
  await db.from("annotations").delete().eq("id", id);
}

/** 跨库检索：在所有"已收录(有摘要)"论文的 标题/摘要/概要/影响 上做 AND 关键词匹配。
 *  当前语料规模下 JS 过滤足够；上千篇时再上 Postgres FTS 索引（ponytail）。 */
export async function searchPapers(q: string): Promise<Paper[]> {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const all = await listArchive(500);
  return all.filter((p) => {
    const hay = `${p.title} ${p.abstract} ${p.summary?.one_liner ?? ""} ${p.summary?.summary_md ?? ""} ${p.summary?.impact_md ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
