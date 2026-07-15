import { createHash } from "node:crypto";
import { notFound } from "next/navigation";
import AnnotatedReader from "@/components/AnnotatedReader";
import FeedbackButtons from "@/components/FeedbackButtons";
import { getAnnotations, getPaper } from "@/lib/data";
import { renderMarkdown } from "@/lib/md";
import { requireOwnerPage } from "@/lib/auth-boundary";

export const dynamic = "force-dynamic";

export default async function PaperPage({ params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwnerPage();
  const { id } = await params;
  const [paper, annotations] = await Promise.all([
    getPaper(owner, id),
    getAnnotations(owner, id),
  ]);
  if (!paper) notFound();

  const summary = paper.summary;
  const signalEntries = Object.entries(paper.signals ?? {})
    .filter(([key]) => ["upvotes", "stars", "category", "publisher"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const contentVersion = createHash("sha256").update(JSON.stringify({
    abstract: paper.abstract,
    authors: paper.authors,
    impact: summary?.impact_md ?? "",
    oneLiner: summary?.one_liner ?? "",
    rank: summary?.rank ?? null,
    rating: paper.rating,
    score: summary?.score ?? null,
    signals: signalEntries,
    source: paper.source,
    summary: summary?.summary_md ?? "",
    title: paper.title,
    url: paper.url,
  })).digest("hex");
  const signals = signalEntries
    .map(([key, value]) => `${key}:${value}`)
    .join(" · ");

  return (
    <AnnotatedReader paperId={id} initial={annotations} contentVersion={contentVersion}>
      <div className="stamp">{paper.source.toUpperCase()}</div>
      <h1 className="headline">{paper.title}</h1>
      <div className="meta">
        {signals ? <>{signals} · </> : null}
        {summary?.score != null ? <>评分 {summary.score} · </> : null}
        {paper.authors?.length ? <>{paper.authors.slice(0, 6).join(", ")} · </> : null}
        <a href={paper.url} target="_blank" rel="noopener noreferrer">原文链接 ↗</a>
      </div>

      <FeedbackButtons itemId={id} initialRating={paper.rating} />

      {summary?.one_liner ? (
        <p className="prose" style={{ fontSize: 16 }}>
          <strong>{summary.one_liner}</strong>
        </p>
      ) : null}

      <div className="section-label">概要 / Summary</div>
      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(summary?.summary_md ?? paper.abstract) }}
      />

      {summary?.impact_md ? (
        <>
          <div className="section-label">对你的影响 / Impact</div>
          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.impact_md) }}
          />
        </>
      ) : null}

      {summary?.score != null ? (
        <div className="rationale">
          归档评分 {summary.score}{summary.rank ? ` · 当日排名 #${summary.rank}` : ""}
        </div>
      ) : null}
    </AnnotatedReader>
  );
}
