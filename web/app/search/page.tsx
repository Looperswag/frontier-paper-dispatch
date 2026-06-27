import Link from "next/link";
import { searchPapers } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const results = query ? await searchPapers(query) : [];

  return (
    <article className="sheet">
      <div className="stamp">检索 / Search</div>
      <h1 className="headline">{query ? `「${query}」` : "跨库检索"}</h1>
      <div className="meta">
        {query ? `在你收录的论文里命中 ${results.length} 篇` : "在左栏搜索框输入关键词，跨你收藏的全部论文检索。"}
      </div>

      {results.map((p) => (
        <Link key={p.id} href={`/paper/${p.id}`} className="search-hit">
          <div className="src">
            [{p.source}]{p.summary?.score != null ? ` · 评分 ${p.summary.score}` : ""}
          </div>
          <div className="hit-title">{p.title}</div>
          {p.summary?.one_liner ? <div className="hit-one">{p.summary.one_liner}</div> : null}
        </Link>
      ))}

      {query && results.length === 0 ? <p className="prose">没有命中。换个关键词试试。</p> : null}
    </article>
  );
}
