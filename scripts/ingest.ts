import { fetchArxiv } from "./fetchers/arxiv.ts";
import { fetchHuggingFace } from "./fetchers/huggingface.ts";
import { fetchGitHub } from "./fetchers/github.ts";
import { fetchBlogs } from "./fetchers/blogs.ts";
import { fetchX } from "./fetchers/x.ts";
import { dedupe } from "../lib/normalize.ts";
import { rankTop } from "./rank.ts";
import { summarizeAll } from "./summarize.ts";
import { renderDigest, pushDigest } from "./digest.ts";
import { upsertItems, saveSummaries, saveDigest } from "../lib/supabase.ts";
import type { NormalizedItem } from "../lib/types.ts";

const FETCHERS = [
  ["arxiv", fetchArxiv],
  ["huggingface", fetchHuggingFace],
  ["github", fetchGitHub],
  ["blog", fetchBlogs],
  ["x", fetchX],
] as const;

const today = () => new Date().toISOString().slice(0, 10);
// 朴素预览信号（dry 模式排序用，不调 LLM）。
const naive = (i: NormalizedItem) => Number(i.signals.upvotes ?? 0) + Number(i.signals.stars ?? 0) / 50;

async function collect(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled(FETCHERS.map(([, fn]) => fn()));
  const items: NormalizedItem[] = [];
  results.forEach((r, i) => {
    const name = FETCHERS[i][0];
    if (r.status === "fulfilled") {
      console.log(`[${name}] ${r.value.length} 条`);
      items.push(...r.value);
    } else {
      console.warn(`[${name}] 失败：${r.reason?.message ?? r.reason}`);
    }
  });
  return dedupe(items);
}

async function main() {
  const dry = process.argv.includes("--dry");
  const send = process.argv.includes("--send");
  console.log(`\n=== 采集开始（${today()}）${dry ? " [dry]" : ""} ===`);

  const items = await collect();
  console.log(`去重后候选：${items.length} 条`);

  if (dry) {
    const preview = [...items].sort((a, b) => naive(b) - naive(a)).slice(0, 15);
    console.log(`\n按朴素信号预览前 15：`);
    for (const it of preview) {
      console.log(`  · [${it.source}] (${naive(it).toFixed(1)}) ${it.title.slice(0, 80)}`);
    }
    console.log(`\n[dry] 未写库、未排名、未发信。配好 .env 后用 \`npm run ingest\` / \`npm run ingest:send\`。`);
    return;
  }

  const idByKey = await upsertItems(items);
  console.log(`已写入 Supabase：${idByKey.size} 条`);

  const ranked = await rankTop(items, 5);
  console.log(`排名 Top5：\n${ranked.map((r) => `  ${r.rank}. (${r.score}) ${r.title.slice(0, 50)}`).join("\n")}`);

  const summarized = await summarizeAll(ranked);
  await saveSummaries(summarized, idByKey);

  const md = renderDigest(today(), summarized);
  await saveDigest(today(), summarized, idByKey, md);

  if (send) {
    await pushDigest(`前沿论文情报台 · ${today()} · Top5`, md);
    console.log("已推送到微信 ✉️");
  } else {
    console.log("（未加 --send，已写库未推送）");
  }
  console.log("\n=== 完成 ===");
}

main().catch((e) => {
  console.error("ingest 失败：", e);
  process.exit(1);
});
