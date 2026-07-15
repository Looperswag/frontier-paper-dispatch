import "server-only";

import OpenAI from "openai";
import { getLLMConfig } from "@/lib/config.server";
import type { OwnerContext } from "@/lib/auth";

// DeepSeek（OpenAI 兼容），仅服务端使用。
export const CHAT_MODEL = "deepseek-chat";

export function deepseek(owner: OwnerContext): OpenAI {
  void owner;
  const config = getLLMConfig();
  // Every physical attempt is covered by the database reservation. Hidden SDK
  // retries would bypass that accounting, so retries are explicit at the
  // orchestration layer and the transport has one bounded deadline.
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: 45_000,
  });
}
