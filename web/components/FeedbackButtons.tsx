"use client";

import { useEffect, useRef, useState } from "react";
import { privateFetch } from "@/lib/private-fetch";

export default function FeedbackButtons({
  itemId,
  initialRating,
}: {
  itemId: string;
  initialRating?: "up" | "down" | null;
}) {
  const [rating, setRating] = useState<"up" | "down" | null>(initialRating ?? null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  async function send(r: "up" | "down", withNote = false) {
    if (pending) return;
    setPending(true);
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSaved(false);
    setFailed(false);
    try {
      const response = await privateFetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, rating: r, note: withNote ? note : undefined }),
      });
      if (!response.ok) throw new Error("feedback save failed");
      const payload = (await response.json()) as { ok?: unknown };
      if (payload.ok !== true) throw new Error("invalid feedback response");
      setRating(r);
      setSaved(true);
      savedTimerRef.current = setTimeout(() => {
        setSaved(false);
        savedTimerRef.current = null;
      }, 1500);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fb" onClick={(e) => e.stopPropagation()}>
      <button disabled={pending} className={`fb-btn ${rating === "up" ? "on" : ""}`} onClick={() => send("up")} aria-label="有用">👍</button>
      <button disabled={pending} className={`fb-btn ${rating === "down" ? "on" : ""}`} onClick={() => send("down")} aria-label="不相关">👎</button>
      <button className="fb-link" onClick={() => setOpen(!open)}>{open ? "收起" : "写理由"}</button>
      {saved ? <span className="fb-saved" aria-live="polite">已记录 ✓</span> : null}
      {failed ? <span className="fb-saved" role="status">记录失败，请重试</span> : null}
      {open ? (
        <span className="fb-note">
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="一句话理由（如：太理论 / 想多看 RAG）"
          />
          <button className="fb-link" disabled={pending || !note.trim() || !rating} onClick={() => rating && send(rating, true)}>
            提交
          </button>
        </span>
      ) : null}
    </div>
  );
}
