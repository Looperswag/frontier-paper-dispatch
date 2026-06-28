import "./globals.css";
import type { ReactNode } from "react";
import PaperList from "@/components/PaperList";
import ChatPanel from "@/components/ChatPanel";

export const metadata = {
  title: "前沿论文情报台",
  description: "每日 AI 前沿 Top5 · 复古电讯版",
};

const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Noto+Serif+SC:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="app">
          <aside className="rail-left">
            <PaperList />
          </aside>
          <main className="center">{children}</main>
          <aside className="rail-right">
            <ChatPanel />
          </aside>
        </div>
        {DEMO && (
          <a
            className="demo-badge"
            href="https://github.com/Looperswag/frontier-paper-dispatch"
            target="_blank"
            rel="noopener noreferrer"
          >
            🔒 只读 Demo · 想要完整功能？⭐ 自部署 →
          </a>
        )}
      </body>
    </html>
  );
}
