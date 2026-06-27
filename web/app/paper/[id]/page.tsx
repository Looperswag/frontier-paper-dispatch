import { notFound } from "next/navigation";
import { getPaper, getAnnotations } from "@/lib/data";
import { renderMarkdown } from "@/lib/md";
import AnnotatedReader from "@/components/AnnotatedReader";

export const dynamic = "force-dynamic";

export default async function PaperPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [paper, annos] = await Promise.all([getPaper(id), getAnnotations(id)]);
  if (!paper) notFound();

  const s = paper.summary;
  const sig = Object.entries(paper.signals ?? {})
    .filter(([k]) => ["upvotes", "stars", "category", "publisher"].includes(k))
    .map(([k, v]) => `${k}:${v}`)
    .join(" · ");

  return (
    <AnnotatedReader paperId={id} initial={annos}>
      <div className="stamp">{paper.source.toUpperCase()}</div>
      <h1 className="headline">{paper.title}</h1>
      <div className="meta">
        {sig ? <>{sig} · </> : null}
        {s?.score != null ? <>评分 {s.score} · </> : null}
        {paper.authors?.length ? <>{paper.authors.slice(0, 6).join(", ")} · </> : null}
        <a href={paper.url} target="_blank" rel="noopener noreferrer">原文链接 ↗</a>
      </div>

      {s?.one_liner ? (
        <p className="prose" style={{ fontSize: 16 }}>
          <strong>{s.one_liner}</strong>
        </p>
      ) : null}

      <div className="section-label">概要 / Summary</div>
      <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(s?.summary_md ?? paper.abstract) }} />

      {s?.impact_md ? (
        <>
          <div className="section-label">对你的影响 / Impact</div>
          <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.impact_md) }} />
        </>
      ) : null}

      {s?.score != null ? (
        <div className="rationale">归档评分 {s.score}{s.rank ? ` · 当日排名 #${s.rank}` : ""}</div>
      ) : null}
    </AnnotatedReader>
  );
}
