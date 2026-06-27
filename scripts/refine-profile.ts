// 画像自动精炼：从批注/提问行为用 DeepSeek 反推，更新「我的画像」。
// 默认只产出建议（config/profile.suggested.md）；--apply 才覆盖 profile.md（并备份 .bak）。
import { readFile, writeFile } from "node:fs/promises";
import { MODELS, complete } from "../lib/llm.ts";
import { fetchSignals } from "../lib/supabase.ts";

const PROFILE = new URL("../config/profile.md", import.meta.url);
const SUGGEST = new URL("../config/profile.suggested.md", import.meta.url);
const BAK = new URL("../config/profile.md.bak", import.meta.url);

function stripFence(s: string): string {
  const m = s.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim() + "\n";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const current = await readFile(PROFILE, "utf8");
  const { annotations, chats } = await fetchSignals();
  const total = annotations.length + chats.length;
  if (total < 3) {
    console.log(`信号太少（批注 ${annotations.length} + 提问 ${chats.length}）。多用几天阅读器、批注/提问几次后再精炼会更准。`);
    return;
  }

  const annoLines = annotations.map((a) => `- [${a.type === "note" ? "便签" : "高亮"}] 《${a.title}》：${a.body}`).join("\n");
  const chatLines = chats.map((c) => `- 问《${c.title}》：${c.content}`).join("\n");

  const system =
    `你在帮我精炼「我的画像」。依据我真实的批注（高亮=我划重点的原文、便签=我的想法）和提问，` +
    `更新画像——但务必【保留】我已写明的角色与当前项目，只在「重点关注方向 / 次要 / 不太关心」上做增删与措辞优化，` +
    `并在末尾追加一节「## 观察到的偏好（自动）」用 3–5 条点出从我的行为里看到的真实兴趣/盲点。` +
    `输出【完整】的画像 markdown，结构与原文保持一致。只输出 markdown，不要任何解释。`;
  const user =
    `# 当前画像\n${current}\n\n` +
    `# 我最近的批注\n${annoLines || "（无）"}\n\n` +
    `# 我最近的提问\n${chatLines || "（无）"}\n\n` +
    `# 任务\n产出精炼后的完整画像 markdown。`;

  const refined = stripFence(await complete({ model: MODELS.summarize, system, user, maxTokens: 2000 }));
  await writeFile(SUGGEST, refined, "utf8");
  console.log(`已生成建议画像 → config/profile.suggested.md（基于 ${annotations.length} 条批注 + ${chats.length} 条提问）`);

  if (apply) {
    await writeFile(BAK, current, "utf8");
    await writeFile(PROFILE, refined, "utf8");
    console.log("已套用到 config/profile.md（原文件备份为 config/profile.md.bak）。");
  } else {
    console.log("审阅 profile.suggested.md 后：`npm run refine:apply` 直接套用，或手动把想要的部分并进 profile.md。");
  }
}

main().catch((e) => {
  console.error("精炼失败：", e);
  process.exit(1);
});
