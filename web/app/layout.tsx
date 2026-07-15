import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "前沿论文情报台",
  description: "每日 AI 前沿 Top5 · 复古电讯版",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
