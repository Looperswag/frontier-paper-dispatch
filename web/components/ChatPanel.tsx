"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

// 右栏电报问询：基于当前打开的论文做满上下文二次问答（不做 RAG）。
export default function ChatPanel() {
  const pathname = usePathname();
  const itemId = pathname?.startsWith("/paper/") ? pathname.split("/")[2] : null;

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 切换论文时载入该篇历史
  useEffect(() => {
    setMsgs([]);
    if (!itemId) return;
    fetch(`/api/chat?itemId=${itemId}`)
      .then((r) => r.json())
      .then((d) => setMsgs(d.chats ?? []))
      .catch(() => {});
  }, [itemId]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text || !itemId || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, message: text }),
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        setMsgs((m) => {
          const c = [...m];
          c[c.length - 1] = { role: "assistant", content: c[c.length - 1].content + chunk };
          return c;
        });
      }
    } catch {
      setMsgs((m) => {
        const c = [...m];
        c[c.length - 1] = { role: "assistant", content: "（出错了，请重试）" };
        return c;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tele-head">◊ 电报问询 · Inquiry</div>
      <div className="tele-body" ref={bodyRef}>
        {!itemId ? (
          <p className="tele-stub">打开任一篇论文后，就能基于它的原文 + 概要在这里追问。</p>
        ) : msgs.length === 0 ? (
          <p className="tele-stub">基于这篇随便问——方法细节、能不能用进你的产品、和某篇的区别…</p>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content || (busy && i === msgs.length - 1 ? "…" : "")}
            </div>
          ))
        )}
      </div>
      <div className="tele-input">
        <input
          value={input}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          disabled={!itemId || busy}
          placeholder={itemId ? (busy ? "思考中…" : "问点什么…（回车发送）") : "先打开一篇论文"}
        />
      </div>
    </>
  );
}
