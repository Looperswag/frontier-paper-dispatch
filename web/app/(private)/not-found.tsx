import Link from "next/link";

export default function PrivateNotFound() {
  return (
    <article className="sheet">
      <div className="stamp">未找到</div>
      <h1 className="headline">这篇内容不存在或已移除</h1>
      <p className="prose">返回最新简报，选择仍在归档中的内容。</p>
      <Link href="/">返回最新简报</Link>
    </article>
  );
}
