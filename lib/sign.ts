import { createHmac } from "node:crypto";

// 一键反馈链接的签名（防伪造、免登录）。ingest 端签发、web 端校验，逻辑两边各放一份。
export function signFeedback(itemId: string, rating: string): string {
  return createHmac("sha256", process.env.FEEDBACK_SECRET ?? "")
    .update(`${itemId}:${rating}`)
    .digest("hex")
    .slice(0, 16);
}

export function verifyFeedback(itemId: string, rating: string, token: string): boolean {
  if (!process.env.FEEDBACK_SECRET) return false;
  const expected = signFeedback(itemId, rating);
  return token.length === expected.length && token === expected;
}
