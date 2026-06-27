// Claude 封装。动态 import SDK，使得 `--dry` 路径无需安装/配置 Anthropic 也能跑。
import type Anthropic from "@anthropic-ai/sdk";

// 模型分层（详见 SPEC）：排名用 Sonnet，影响综合用 Opus。
export const MODELS = {
  rank: "claude-sonnet-4-6",
  summarize: "claude-opus-4-8",
} as const;

let client: Anthropic | null = null;

async function getClient(): Promise<Anthropic> {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("缺少 ANTHROPIC_API_KEY（见 .env.example）");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  client = new Anthropic({ apiKey: key });
  return client;
}

/** 文本补全：返回 assistant 的纯文本。 */
export async function complete(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const c = await getClient();
  const msg = await c.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 期望 JSON 输出：从回复中抽取首个 JSON 块并解析。 */
export async function completeJSON<T>(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const text = await complete(opts);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.search(/[[{]/));
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Claude 未返回可解析 JSON：\n${text.slice(0, 500)}`);
  }
}
