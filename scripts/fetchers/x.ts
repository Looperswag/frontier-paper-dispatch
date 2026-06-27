import type { NormalizedItem } from "../../lib/types.ts";

// X / Twitter 源（best-effort）。
//
// 现状：agent-reach 已装，但 twitter 后端未启用（无 active backend）。启用步骤：
//   1. pipx install twitter-cli   （或 uv tool install twitter-cli）
//   2. 用 `agent-reach setup` / `agent-reach configure` 登录授权
//   3. 在本函数里 shell out 调 `twitter-cli`（命令/输出格式以其 --help 为准）解析为 NormalizedItem
//
// 注意：agent-reach 本身是安装/编排器（命令仅 setup/install/configure/doctor/format…），
// 没有 `agent-reach twitter search` 子命令；真正抓取走底层的 twitter-cli。
// 未启用前静默返回空，不阻塞 arxiv/HF/github/blog 四个高质量源。
export async function fetchX(): Promise<NormalizedItem[]> {
  return [];
}
