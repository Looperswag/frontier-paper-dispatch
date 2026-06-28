import Link from "next/link";
import { getTop5 } from "@/lib/data";
import FeedbackButtons from "@/components/FeedbackButtons";

export const dynamic = "force-dynamic"; // 始终读最新 digest

export default async function Home() {
  const { date, papers } = await getTop5();

  if (!papers.length) {
    return (
      <article className="sheet">
        <div className="stamp">每日电讯</div>
        <h1 className="headline">尚无简报</h1>
        <p className="prose">
          数据库里还没有 digest。先在 <code>平台/</code> 下跑一次
          <code> npm run ingest</code>，再回来刷新。
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
          {papers.map((p) => (
            <li key={p.id} style={{ marginBottom: 16 }}>
              <Link href={`/paper/${p.id}`}>{p.title}</Link>
              <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                [{p.source}] {p.summary?.one_liner}
              </div>
              <FeedbackButtons itemId={p.id} initialRating={p.rating} />
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}
