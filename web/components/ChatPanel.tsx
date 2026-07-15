"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { privateFetch } from "@/lib/private-fetch";

type Msg = { role: "user" | "assistant"; content: string };
type DisplayMsg = Msg & {
  id: string;
  status: "confirmed" | "failed" | "pending";
};
type HistoryState = "failed" | "loading" | "ready";
function isMessage(value: unknown): value is Msg {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as { content?: unknown; role?: unknown };
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

// 右栏电报问询：基于当前打开的论文做满上下文二次问答（不做 RAG）。
export default function ChatPanel() {
  const pathname = usePathname();
  const itemId = pathname?.startsWith("/paper/") ? pathname.split("/")[2] : null;

  const [msgs, setMsgs] = useState<DisplayMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyState, setHistoryState] = useState<HistoryState>("loading");
  const bodyRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const turnRef = useRef(0);

  // 切换论文时载入该篇历史
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    sendAbortRef.current?.abort();
    void readerRef.current?.cancel().catch(() => {});
    sendAbortRef.current = null;
    readerRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setMsgs([]);
    setHistoryState(!itemId ? "ready" : "loading");
    if (!itemId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await privateFetch(`/api/chat?itemId=${itemId}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("history request failed");
        const payload = (await response.json()) as { chats?: unknown };
        if (!Array.isArray(payload.chats) || !payload.chats.every(isMessage)) {
          throw new Error("invalid history response");
        }
        if (generationRef.current === generation) {
          setMsgs(
            payload.chats.map((message, index) => ({
              ...message,
              id: `history-${generation}-${index}`,
              status: "confirmed",
            })),
          );
          setHistoryState("ready");
        }
      } catch {
        if (!controller.signal.aborted && generationRef.current === generation) {
          setHistoryState("failed");
        }
      }
    })();
    return () => {
      controller.abort();
      if (generationRef.current === generation) generationRef.current += 1;
      sendAbortRef.current?.abort();
      void readerRef.current?.cancel().catch(() => {});
    };
  }, [itemId]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (
      !text ||
      !itemId ||
      historyState !== "ready" ||
      busyRef.current
    ) {
      return;
    }
    const generation = generationRef.current;
    const turn = turnRef.current + 1;
    turnRef.current = turn;
    const userId = `turn-${generation}-${turn}-user`;
    const assistantId = `turn-${generation}-${turn}-assistant`;
    const controller = new AbortController();
    sendAbortRef.current = controller;
    busyRef.current = true;
    setInput("");
    setBusy(true);
    setMsgs((messages) => [
      ...messages,
      { id: userId, role: "user", content: text, status: "pending" },
      { id: assistantId, role: "assistant", content: "", status: "pending" },
    ]);
    let responseAccepted = false;
    try {
      const res = await privateFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, message: text }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("chat request failed");
      if (!res.body) throw new Error("no stream");
      responseAccepted = true;
      if (generationRef.current !== generation) throw new Error("stale chat response");
      setMsgs((messages) =>
        messages.map((message) =>
          message.id === userId ? { ...message, status: "confirmed" } : message,
        ),
      );
      const reader = res.body.getReader();
      readerRef.current = reader;
      const dec = new TextDecoder();
      let received = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (generationRef.current !== generation) throw new Error("stale chat stream");
        const chunk = dec.decode(value, { stream: true });
        received += chunk;
        setMsgs((messages) =>
          messages.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + chunk }
              : message,
          ),
        );
      }
      const tail = dec.decode();
      received += tail;
      if (tail && generationRef.current === generation) {
        setMsgs((messages) =>
          messages.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + tail }
              : message,
          ),
        );
      }
      if (!received.trim()) throw new Error("empty chat response");
      if (generationRef.current === generation) {
        setMsgs((messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, status: "confirmed" } : message,
          ),
        );
      }
    } catch {
      if (generationRef.current === generation) {
        setMsgs((messages) =>
          messages.map((message) => {
            if (message.id === userId && !responseAccepted) {
              return { ...message, status: "failed" };
            }
            if (message.id === assistantId) {
              return {
                ...message,
                content: "（出错了，请重试）",
                status: "failed",
              };
            }
            return message;
          }),
        );
      }
    } finally {
      if (generationRef.current === generation) {
        busyRef.current = false;
        setBusy(false);
        if (sendAbortRef.current === controller) sendAbortRef.current = null;
        readerRef.current = null;
      }
    }
  }

  return (
    <>
      <div className="tele-head">◊ 电报问询 · Inquiry</div>
      <div className="tele-body" ref={bodyRef}>
        {!itemId ? (
          <p className="tele-stub">打开任一篇论文后，就能基于它的原文 + 概要在这里追问。</p>
        ) : historyState === "loading" ? (
          <p className="tele-stub" role="status">历史加载中…</p>
        ) : historyState === "failed" ? (
          <p className="tele-stub" role="status">历史加载失败，请刷新重试</p>
        ) : msgs.length === 0 ? (
          <p className="tele-stub">
            基于这篇随便问——方法细节、能不能用进你的产品、和某篇的区别…
          </p>
        ) : (
          msgs.map((message) => (
            <div key={message.id} className={`msg ${message.role}`}>
              {message.content || (message.status === "pending" ? "…" : "")}
              {message.role === "user" && message.status === "failed"
                ? "（未确认保存）"
                : ""}
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
          disabled={!itemId || busy || historyState !== "ready"}
          placeholder={
            itemId ? (busy ? "思考中…" : "问点什么…（回车发送）") : "先打开一篇论文"
          }
        />
      </div>
    </>
  );
}
