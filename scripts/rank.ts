import { readFile } from "node:fs/promises";
import { MODELS, completeJSON } from "../lib/llm.ts";
import type { NormalizedItem, RankedItem } from "../lib/types.ts";

const PROFILE_PATH = new URL("../config/profile.md", import.meta.url);

/** 用 DeepSeek 依据画像对候选打分，返回 Top n（带分数与理由）。
 *  feedbackSummary：近期 Top5 反馈（👍/👎+理由），用于即时调整推荐方向。 */
export async function rankTop(
  items: NormalizedItem[],
  n = 5,
  feedbackSummary = "",
): Promise<RankedItem[]> {
  const profile = await readFile(PROFILE_PATH, "utf8");
  const candidates = items.map((it, idx) => ({
    idx,
    source: it.source,
    title: it.title,
    abstract: it.abstract.slice(0, 400),
    signals: it.signals,
  }));

  const system =
    `你是我的前沿论文情报官。依据「我的画像」给每个候选打分（0–100），分数反映「对我的价值」：` +
    `与我项目/关注方向的相关度、信息新颖度、可落地性；并参考 signals（upvotes/stars/sourceWeight 越高越值得关注）。` +
    `若提供「我最近的反馈」，请显著上调与 👍 同类、下调与 👎 同类的候选。只输出 JSON。`;
  const user =
    `# 我的画像\n${profile}\n\n` +
    (feedbackSummary ? `# 我最近的反馈（据此调整方向）\n${feedbackSummary}\n\n` : "") +
    `# 候选项（共 ${candidates.length}）\n${JSON.stringify(candidates)}\n\n` +
    `# 输出\n返回 JSON 对象 {"ranked": [ {"idx": number, "score": number, "rationale": "一句话中文理由"}, ... ]}，` +
    `ranked 按 score 降序，只保留最值得我看的前 ${n} 项。`;

  const out = await completeJSON<{ ranked: { idx: number; score: number; rationale: string }[] }>({
    model: MODELS.rank,
    system,
    user,
    maxTokens: 2000,
  });

  return (out.ranked ?? [])
    .filter((r) => items[r.idx])
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((r, i) => ({ ...items[r.idx], score: r.score, rank: i + 1, rationale: r.rationale }));
}
