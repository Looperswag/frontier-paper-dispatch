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

// 极简 markdown → 邮件 HTML（不引依赖）：转义后保留排版、加粗、链接化。
function mdToHtml(md: string): string {
  const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inner = esc
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return (
    `<div style="max-width:720px;margin:0 auto;padding:16px;` +
    `font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.7;` +
    `white-space:pre-wrap;color:#2b2b2b;background:#f4ecd8">${inner}</div>`
  );
}

/** 经 Resend 发送每日邮件（动态 import，`--dry` 不触达）。 */
export async function sendDigestEmail(subject: string, md: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_TO;
  const from = process.env.DIGEST_FROM;
  if (!key || !to || !from) throw new Error("缺少 RESEND_API_KEY / DIGEST_TO / DIGEST_FROM（见 .env.example）");
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { error } = await resend.emails.send({ from, to, subject, text: md, html: mdToHtml(md) });
  if (error) throw new Error(`Resend 发送失败：${JSON.stringify(error)}`);
}
