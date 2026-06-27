import OpenAI from "openai";

// DeepSeek（OpenAI 兼容），仅服务端使用。
export const CHAT_MODEL = "deepseek-chat";

export function deepseek(): OpenAI {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("缺少 DEEPSEEK_API_KEY（web/.env.local）");
  return new OpenAI({ apiKey: key, baseURL: "https://api.deepseek.com" });
}
