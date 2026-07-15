import LoginForm from "@/components/LoginForm";
import { normalizeReturnTo } from "@/lib/return-to";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: "noindex, nofollow, noarchive",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnTo = normalizeReturnTo((await searchParams).returnTo);
  return (
    <main className="login-shell">
      <article className="sheet login-sheet">
        <div className="stamp">私人电讯 / Private Dispatch</div>
        <h1 className="headline">身份验证</h1>
        <p className="meta">请输入预先配置的单一 owner 账户口令。</p>
        <LoginForm returnTo={returnTo} />
      </article>
    </main>
  );
}
