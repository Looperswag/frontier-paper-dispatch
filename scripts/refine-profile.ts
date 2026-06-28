// 画像 + 选源范围 自动精炼：从 反馈 / 批注 / 提问 用 DeepSeek 反推。
// 默认只产出建议（profile.suggested.md + scope.suggested.md）；--apply 才覆盖 profile.md（并备份 .bak）。
import { readFile, writeFile } from "node:fs/promises";
import { MODELS, complete } from "../lib/llm.ts";
import { fetchSignals, fetchFeedback, feedbackSummary } from "../lib/supabase.ts";

const PROFILE = new URL("../config/profile.md", import.meta.url);
const SUGGEST = new URL("../config/profile.suggested.md", import.meta.url);
const BAK = new URL("../config/profile.md.bak", import.meta.url);
const SOURCES = new URL("../config/sources.ts", import.meta.url);
const SCOPE_SUGGEST = new URL("../config/scope.suggested.md", import.meta.url);

function stripFence(s: string): string {
  const m = s.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim() + "\n";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const current = await readFile(PROFILE, "utf8");
  const { annotations, chats } = await fetchSignals();
  const fb = await fetchFeedback();
  const fbText = feedbackSummary(fb);
  const total = annotations.length + chats.length + fb.length;
  if (total < 3) {
    console.log(`信号太少（反馈 ${fb.length} + 批注 ${annotations.length} + 提问 ${chats.length}）。多用几天、对推送点几次 👍/👎 再精炼会更准。`);
    return;
  }

  const annoLines = annotations.map((a) => `- [${a.type === "note" ? "便签" : "高亮"}] 《${a.title}》：${a.body}`).join("\n");
  const chatLines = chats.map((c) => `- 问《${c.title}》：${c.content}`).join("\n");

  // ── 1) 精炼画像 ──
  const sys1 =
    `你在帮我精炼「我的画像」。依据我对每日 Top5 的反馈（👍/👎+理由，最强信号）、批注、提问，` +
    `更新画像——务必【保留】我已写明的角色与当前项目，只在「重点关注方向 / 次要 / 不太关心」上做增删与措辞优化，` +
    `并在末尾追加一节「## 观察到的偏好（自动）」用 3–5 条点出从我的行为里看到的真实兴趣/盲点。` +
    `输出【完整】的画像 markdown，结构与原文一致。只输出 markdown，不要解释。`;
  const user1 =
    `# 当前画像\n${current}\n\n` +
    `# 我对每日 Top5 的反馈\n${fbText || "（无）"}\n\n` +
    `# 我的批注\n${annoLines || "（无）"}\n\n# 我的提问\n${chatLines || "（无）"}\n\n# 任务\n产出精炼后的完整画像 markdown。`;
  const refined = stripFence(await complete({ model: MODELS.summarize, system: sys1, user: user1, maxTokens: 2000 }));
  await writeFile(SUGGEST, refined, "utf8");
  console.log(`已生成 config/profile.suggested.md（反馈 ${fb.length} + 批注 ${annotations.length} + 提问 ${chats.length}）`);

  // ── 2) 选源范围建议（仅当有反馈时；改 sources.ts 由你手动） ──
  if (fb.length) {
    const sources = await readFile(SOURCES, "utf8");
    const sys2 =
      `你在帮我调整「选源范围」。给定当前源配置(sources.ts)与我对每日 Top5 的反馈，给出对 sources.ts 的【具体】增删/调权建议` +
      `（如「加 arxiv 分类 cs.RO」「github topic:diffusion-models 降权或移除」「blog 加 X」「某来源 sourceWeight 调高/低」）。` +
      `只针对我反复 👍/👎 的方向；没有明显信号就直说「暂无足够信号」。输出简短 markdown 清单，不要改写整个文件。`;
    const user2 =
      `# 当前源配置 sources.ts\n\`\`\`ts\n${sources}\n\`\`\`\n\n# 我的反馈\n${fbText}\n\n# 任务\n给出对 sources.ts 的选源调整建议。`;
    const scope = stripFence(await complete({ model: MODELS.summarize, system: sys2, user: user2, maxTokens: 1200 }));
    await writeFile(SCOPE_SUGGEST, `# 选源范围建议（自动，供参考）\n\n${scope}`, "utf8");
    console.log("已生成 config/scope.suggested.md（审阅后手动改 config/sources.ts）");
  }

  if (apply) {
    await writeFile(BAK, current, "utf8");
    await writeFile(PROFILE, refined, "utf8");
    console.log("已套用画像到 config/profile.md（原文件备份为 .bak）。选源仍需你手动改 sources.ts。");
  } else {
    console.log("审阅后：`npm run refine:apply` 套用画像；选源按 scope.suggested.md 手动改 sources.ts。");
  }
}

main().catch((e) => {
  console.error("精炼失败：", e);
  process.exit(1);
});
