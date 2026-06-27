import type { NormalizedItem } from "../../lib/types.ts";

// Phase 5：经由 agent-reach skill 抓取配置的 AI 账号 / 关键词。
// best-effort —— 接入前返回空，不阻塞其余源（见 SPEC「难抓源」决定）。
export async function fetchX(): Promise<NormalizedItem[]> {
  return [];
}
