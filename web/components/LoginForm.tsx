"use client";

import { normalizeReturnTo } from "@/lib/return-to";
import { useState, type FormEvent } from "react";

const MAX_PASSWORD_BYTES = 1024;

function failureMessage(status: number): string {
  if (status === 401) return "登录失败，请检查口令后重试";
  if (status === 429) return "尝试过于频繁，请稍后再试";
  return "登录服务暂不可用，请稍后再试";
}

export default function LoginForm({ returnTo = "/" }: { returnTo?: string }) {
  const safeReturnTo = normalizeReturnTo(returnTo);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || pending) return;
    if (new TextEncoder().encode(password).byteLength > MAX_PASSWORD_BYTES) {
      setError("口令过长，请检查后重试");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        body: new URLSearchParams({ password }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      if (!response.ok) {
        setError(failureMessage(response.status));
        return;
      }
      globalThis.location.replace(safeReturnTo);
    } catch {
      setError(failureMessage(503));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="owner-password">访问口令</label>
      <input
        id="owner-password"
        type="password"
        autoComplete="current-password"
        maxLength={1024}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit" disabled={pending}>
        {pending ? "验证中…" : "进入情报台"}
      </button>
      {error ? <p role="status">{error}</p> : null}
    </form>
  );
}
