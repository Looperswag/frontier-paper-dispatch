import { createHmac } from "node:crypto";

// 与 ../../lib/sign.ts 逻辑一致：校验微信一键反馈链接的签名（仅 nodejs runtime 调用）。
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
