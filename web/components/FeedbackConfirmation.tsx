"use client";

import { useState } from "react";
import Link from "next/link";

type Rating = "up" | "down";

function failureMessage(status: number): string {
  if (status === 409) return "这条反馈已经记录过";
  if (status === 410) return "链接无效或已过期";
  if (status === 503) return "记录服务暂不可用";
  return "记录失败，请稍后重试";
}

export default function FeedbackConfirmation({
  rating,
  token,
}: Readonly<{ rating: Rating; token: string }>) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const label = rating === "up" ? "有用" : "不相关";

  async function confirm(): Promise<void> {
    if (pending || settled) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/feedback/redeem", {
        body: JSON.stringify({ token }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        if (response.status === 409) setSettled(true);
        setMessage(failureMessage(response.status));
        return;
      }
      const result: unknown = await response.json();
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(",") !== "ok,rating" ||
        (result as { ok?: unknown }).ok !== true ||
        (result as { rating?: unknown }).rating !== rating
      ) {
        setMessage("记录失败，请稍后重试");
        return;
      }
      setSettled(true);
      setMessage(`已记录为${label}`);
    } catch {
      setMessage("记录失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      {!settled ? <p>尚未记录。请确认是否将这篇内容标记为“{label}”。</p> : null}
      <button type="button" disabled={pending || settled} onClick={confirm}>
        {pending ? "记录中…" : `确认记录为${label}`}
      </button>
      <Link href="/">取消并返回首页</Link>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
