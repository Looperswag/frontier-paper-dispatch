"use client";

import { useState } from "react";

const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

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

  if (DEMO) return null;

  async function send(r: "up" | "down", withNote = false) {
    setRating(r);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, rating: r, note: withNote ? note : undefined }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="fb" onClick={(e) => e.stopPropagation()}>
      <button className={`fb-btn ${rating === "up" ? "on" : ""}`} onClick={() => send("up")} aria-label="有用">👍</button>
      <button className={`fb-btn ${rating === "down" ? "on" : ""}`} onClick={() => send("down")} aria-label="不相关">👎</button>
      <button className="fb-link" onClick={() => setOpen(!open)}>{open ? "收起" : "写理由"}</button>
      {saved ? <span className="fb-saved">已记录 ✓</span> : null}
      {open ? (
        <span className="fb-note">
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="一句话理由（如：太理论 / 想多看 RAG）"
          />
          <button className="fb-link" disabled={!note.trim() || !rating} onClick={() => rating && send(rating, true)}>
            提交
          </button>
        </span>
      ) : null}
    </div>
  );
}
