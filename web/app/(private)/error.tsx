"use client";

export default function PrivateError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <article className="sheet" role="alert">
      <div className="stamp">读取失败</div>
      <h1 className="headline">暂时无法读取私人数据</h1>
      <p className="prose">已保留现有数据；请检查网络后重试。</p>
      <button type="button" onClick={reset}>重试读取</button>
    </article>
  );
}
