import Link from "next/link";
import { searchPapers } from "@/lib/data";
import { requireOwnerPage } from "@/lib/auth-boundary";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const owner = await requireOwnerPage();
  const { q = "" } = await searchParams;
  const query = q.trim();
  const results = query ? await searchPapers(owner, query) : [];

  return (
    <article className="sheet">
      <div className="stamp">检索 / Search</div>
      <h1 className="headline">{query ? `「${query}」` : "跨库检索"}</h1>
      <div className="meta">
        {query
          ? `在最近最多 500 篇有摘要项目中命中 ${results.length} 篇`
          : "在左栏搜索框输入关键词，检索最近最多 500 篇有摘要项目。"}
      </div>

      {results.map((paper) => (
        <Link key={paper.id} href={`/paper/${paper.id}`} className="search-hit">
          <div className="src">
            [{paper.source}]
            {paper.summary?.score != null ? ` · 评分 ${paper.summary.score}` : ""}
          </div>
          <div className="hit-title">{paper.title}</div>
          {paper.summary?.one_liner ? (
            <div className="hit-one">{paper.summary.one_liner}</div>
          ) : null}
        </Link>
      ))}

      {query && results.length === 0 ? <p className="prose">没有命中。换个关键词试试。</p> : null}
    </article>
  );
}
