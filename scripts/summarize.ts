import { readFile } from "node:fs/promises";
import { MODELS, completeJSON } from "../lib/llm.ts";
import type { RankedItem, SummarizedItem } from "../lib/types.ts";

const PROFILE_PATH = new URL("../config/profile.md", import.meta.url);

async function summarizeItem(item: RankedItem, profile: string): Promise<SummarizedItem> {
  const system =
    `你是务实、信息密度高的中英双语科技分析师。中文为主，关键术语/专有名词保留英文。不要套话。只输出 JSON。`;
  const user =
    `# 我的画像\n${profile}\n\n` +
    `# 论文/项目\n标题：${item.title}\n来源：${item.source}\n链接：${item.url}\n` +
    `作者：${item.authors.join(", ")}\n摘要：${item.abstract}\n\n` +
    `# 输出 JSON\n{\n` +
    `  "oneLiner": "一句话核心看点（中文，≤40字）",\n` +
    `  "summaryMd": "概要（markdown，3-6 句：它做了什么、关键方法/结果）",\n` +
    `  "impactMd": "对我的影响（markdown，结合画像：能否用进我的项目、改变了什么判断、接下来该做什么；2-4 条）"\n}`;

  const out = await completeJSON<{ oneLiner: string; summaryMd: string; impactMd: string }>({
    model: MODELS.summarize,
    system,
    user,
    maxTokens: 2000,
  });
  return { ...item, ...out };
}

/** 对 Top5 逐条生成概要 + 影响（量小，顺序执行避免速率峰值）。 */
export async function summarizeAll(items: RankedItem[]): Promise<SummarizedItem[]> {
  const profile = await readFile(PROFILE_PATH, "utf8");
  const out: SummarizedItem[] = [];
  for (const it of items) out.push(await summarizeItem(it, profile));
  return out;
}
