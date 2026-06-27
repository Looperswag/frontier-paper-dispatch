"use client";

// 自定义全局错误边界：规避 Next 16 Turbopack 找不到内置 global-error 模块的 bundler bug。
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="zh">
      <body style={{ fontFamily: "ui-monospace, monospace", padding: 48, background: "#bfa276", color: "#3a2f25" }}>
        <h2>电讯中断 / Something broke</h2>
        <p style={{ color: "#8a3324" }}>{error?.message ?? "未知错误"}</p>
        <button onClick={() => reset()} style={{ marginTop: 16, padding: "6px 16px" }}>
          重试
        </button>
      </body>
    </html>
  );
}
