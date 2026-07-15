import type { Metadata } from "next";
import Link from "next/link";
import FeedbackConfirmation from "@/components/FeedbackConfirmation";
import { requireOwnerPage } from "@/lib/auth-boundary";
import { verifyFeedbackToken } from "@/lib/sign";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "确认反馈 · 前沿论文情报台",
};

type SearchParams = Record<string, string | string[] | undefined>;

function message(text: string) {
  return (
    <main className="login-shell">
      <article className="sheet login-sheet">
        <div className="stamp">私人反馈 / Private Feedback</div>
        <h1 className="headline">确认反馈</h1>
        <p className="meta">{text}</p>
        <Link href="/">返回首页</Link>
      </article>
    </main>
  );
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOwnerPage();
  const params = await searchParams;
  const token = params.token;
  if (
    Object.keys(params).length !== 1 ||
    typeof token !== "string" ||
    token.length === 0 ||
    new TextEncoder().encode(token).byteLength > 256
  ) {
    return message("链接无效或已过期。");
  }

  let claims;
  try {
    claims = verifyFeedbackToken(token);
  } catch {
    return message("反馈服务暂不可用，请稍后重试。");
  }
  if (!claims) return message("链接无效或已过期。");

  return (
    <main className="login-shell">
      <article className="sheet login-sheet">
        <div className="stamp">私人反馈 / Private Feedback</div>
        <h1 className="headline">确认反馈</h1>
        <p className="meta">日报日期：{claims.digestDate}</p>
        <FeedbackConfirmation rating={claims.rating} token={token} />
      </article>
    </main>
  );
}
