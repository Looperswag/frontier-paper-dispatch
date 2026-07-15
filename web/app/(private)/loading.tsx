export default function PrivateLoading() {
  return (
    <article className="sheet" aria-busy="true" aria-live="polite">
      <div className="stamp">正在同步</div>
      <h1 className="headline">正在读取私人简报</h1>
      <p className="prose" role="status">请稍候，页面尚未完成加载。</p>
    </article>
  );
}
