import { getPaper, getAnnotations, type Annotation } from "@/lib/data";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { highlight: "高亮", note: "便签", pen: "画笔", box: "框选" };

function annoLines(annos: Annotation[]): string[] {
  return annos.map((a) => {
    const tag = LABEL[a.type] ?? a.type;
    if (a.type === "highlight") return `- **${tag}**：${a.body ?? "(已标记文本)"}`;
    if (a.type === "note") return `- **${tag}**：${a.body ?? ""}`;
    return `- **${tag}**：（在原文上的手绘标记）`;
  });
}

function buildMarkdown(p: NonNullable<Awaited<ReturnType<typeof getPaper>>>, annos: Annotation[]): string {
  const s = p.summary;
  const parts = [
    `# ${p.title}`,
    ``,
    `- 来源：${p.source} · ${p.url}`,
    p.authors?.length ? `- 作者：${p.authors.join(", ")}` : "",
    s?.one_liner ? `\n> ${s.one_liner}` : "",
    `\n## 概要\n\n${s?.summary_md ?? p.abstract}`,
    s?.impact_md ? `\n## 对我的影响\n\n${s.impact_md}` : "",
    annos.length ? `\n## 我的批注\n\n${annoLines(annos).join("\n")}` : "",
    `\n---\n*导出自 前沿论文情报台*`,
  ];
  return parts.filter(Boolean).join("\n");
}

function mdBlockToParagraphs(md: string): Paragraph[] {
  return md.split("\n").map((line) => {
    const t = line.trim();
    if (t.startsWith("## ")) return new Paragraph({ text: t.slice(3), heading: HeadingLevel.HEADING_2 });
    if (t.startsWith("# ")) return new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_1 });
    if (t.startsWith("> ")) return new Paragraph({ children: [new TextRun({ text: t.slice(2), italics: true })] });
    if (t.startsWith("- ")) return new Paragraph({ text: t.slice(2), bullet: { level: 0 } });
    return new Paragraph({ text: line.replace(/\*\*/g, "") });
  });
}

async function buildDocx(md: string): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: mdBlockToParagraphs(md) }] });
  return Packer.toBuffer(doc);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") ?? "md";
  const paper = await getPaper(id);
  if (!paper) return new Response("not found", { status: 404 });
  const annos = await getAnnotations(id);
  const md = buildMarkdown(paper, annos);

  const safe = (paper.title || "paper").replace(/[^\w一-龥]+/g, "_").slice(0, 40);
  const fn = (ext: string) => `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.${ext}`;

  if (format === "docx") {
    const buf = await buildDocx(md);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": fn("docx"),
      },
    });
  }
  // 默认 markdown
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": fn("md") },
  });
}
