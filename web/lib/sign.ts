import "server-only";

import { createHmac } from "node:crypto";
import { getFeedbackConfig } from "@/lib/config.server";
import {
  verifyFeedbackToken as verifyWithSecret,
  type VerifiedFeedbackTokenClaims,
} from "@/lib/feedback-token";

export function verifyFeedbackToken(
  token: string,
  now: Date | number = Date.now(),
): VerifiedFeedbackTokenClaims | undefined {
  return verifyWithSecret(getFeedbackConfig().secret, token, now);
}

// FB-01 完成切换前仅供旧 owner-only GET 拒绝/兼容；不得签发新链接。
export function signFeedback(itemId: string, rating: string): string {
  return createHmac("sha256", getFeedbackConfig().secret)
    .update(`${itemId}:${rating}`)
    .digest("hex")
    .slice(0, 16);
}

export function verifyFeedback(itemId: string, rating: string, token: string): boolean {
  try {
    const expected = signFeedback(itemId, rating);
    return token.length === expected.length && token === expected;
  } catch {
    return false;
  }
}
