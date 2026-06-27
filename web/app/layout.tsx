import "./globals.css";
import type { ReactNode } from "react";
import PaperList from "@/components/PaperList";
import ChatPanel from "@/components/ChatPanel";

export const metadata = {
  title: "前沿论文情报台",
  description: "每日 AI 前沿 Top5 · 复古电讯版",
};

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
      </body>
    </html>
  );
}
