import Link from "next/link";
import FeedbackButtons from "@/components/FeedbackButtons";
import { getTop5 } from "@/lib/data";
import { requireOwnerPage } from "@/lib/auth-boundary";

export const dynamic = "force-dynamic";

export default async function Home() {
  const owner = await requireOwnerPage();
  const { date, papers } = await getTop5(owner);

  if (!papers.length) {
    return (
      <article className="sheet">
        <div className="stamp">每日电讯</div>
        <h1 className="headline">尚无简报</h1>
        <p className="prose">
          数据库里还没有 digest。请先在仓库根目录运行 <code>npm run ingest</code>
          ，再回来刷新。
        </p>
      </article>
    );
  }

  return (
    <article className="sheet">
      <div className="stamp">每日电讯 · {date}</div>
      <h1 className="headline">今日前沿 · Top {papers.length}</h1>
      <div className="meta">按对你的价值排序 · 点击任一条进入正文与批注</div>

      <div className="section-label">目录 / Index</div>
      <div className="prose">
        <ol>
          {papers.map((paper) => (
            <li key={paper.id} style={{ marginBottom: 16 }}>
              <Link href={`/paper/${paper.id}`}>{paper.title}</Link>
              <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                [{paper.source}] {paper.summary?.one_liner}
              </div>
              <FeedbackButtons itemId={paper.id} initialRating={paper.rating} />
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}
