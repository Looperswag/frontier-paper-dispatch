import type { ReactNode } from "react";
import ChatPanel from "@/components/ChatPanel";
import PaperList from "@/components/PaperList";
import { requireOwnerPage } from "@/lib/auth-boundary";

export default async function PrivateLayout({ children }: { children: ReactNode }) {
  await requireOwnerPage();
  return (
    <div className="app">
      <aside className="rail-left">
        <form action="/api/auth/logout" method="post" className="logout-form">
          <button type="submit">退出当前会话</button>
        </form>
        <PaperList />
      </aside>
      <main className="center">{children}</main>
      <aside className="rail-right">
        <ChatPanel />
      </aside>
    </div>
  );
}
