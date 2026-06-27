import type { SummarizedItem } from "../lib/types.ts";

const SHOW_SIGNALS = ["upvotes", "stars", "category", "publisher"];

/** 渲染每日简报 markdown（也是写进 digests.rendered_md 的内容）。 */
export function renderDigest(date: string, items: SummarizedItem[]): string {
  const head = `# 前沿论文情报台 · ${date}\n\n> 今日 Top ${items.length}（按对你的价值排序）。\n\n---\n\n`;
  const body = items
    .map((it) => {
      const sig = Object.entries(it.signals)
        .filter(([k]) => SHOW_SIGNALS.includes(k))
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      return [
        `## ${it.rank}. ${it.title}`,
        ``,
        `- 来源：${it.source}${sig ? ` · ${sig}` : ""} · 评分 ${it.score}`,
        `- 链接：${it.url}`,
        `- 作者：${it.authors.slice(0, 6).join(", ") || "—"}`,
        ``,
        `**一句话看点**　${it.oneLiner}`,
        ``,
        `**概要**`,
        ``,
        it.summaryMd,
        ``,
        `**对你的影响**`,
        ``,
        it.impactMd,
        ``,
        `> 入选理由：${it.rationale}`,
        ``,
        `---`,
      ].join("\n");
    })
    .join("\n\n");
  return head + body;
}

/** 推送到微信（Server酱 / ServerChan）。markdown 直接作为 desp，无需 SDK。
 *  自动适配两种 SendKey：老版 Turbo（SCT...）走 ftqq，Server酱³（sctp<uid>t...）走 ft07。 */
export async function pushDigest(title: string, md: string): Promise<void> {
  const key = process.env.SERVERCHAN_SENDKEY;
  if (!key) throw new Error("缺少 SERVERCHAN_SENDKEY（见 .env.example）");
  const uid = key.match(/^sctp(\d+)t/)?.[1];
  const url = uid
    ? `https://${uid}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: title.slice(0, 32), desp: md }),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Server酱 推送失败：HTTP ${res.status} ${JSON.stringify(json)}`);
  }
}
