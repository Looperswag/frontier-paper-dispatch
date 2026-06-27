import Link from "next/link";
import { listArchive } from "@/lib/data";

// 左栏归档（async server component，直接读 Supabase）。
export default async function PaperList() {
  const papers = await listArchive();
  return (
    <>
      <div className="brand">
        <h1>前沿论文情报台</h1>
        <div className="sub">Frontier Dispatch</div>
      </div>
      <hr className="rail-sep" />
      {papers.length === 0 ? (
        <p className="tele-stub">归档为空。先在本地跑一次 <code>npm run ingest</code>。</p>
      ) : (
        papers.map((p) => (
          <Link key={p.id} href={`/paper/${p.id}`} className="card">
            {p.summary?.rank ? <span className="rank">{p.summary.rank}</span> : null}
            <div className="src">{p.source}</div>
            <div className="title">{p.title}</div>
            {p.summary?.one_liner ? <div className="one">{p.summary.one_liner}</div> : null}
          </Link>
        ))
      )}
    </>
  );
}
