// LLM 封装 —— DeepSeek（OpenAI 兼容协议）。动态/惰性 import，使 `--dry` 路径无需配置密钥。
import OpenAI from "openai";

// deepseek-chat = DeepSeek-V3（通用）；如需更强推理可换 deepseek-reasoner（更慢/不支持 json 模式）。
export const MODELS = {
  rank: "deepseek-chat",
  summarize: "deepseek-chat",
} as const;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("缺少 DEEPSEEK_API_KEY（见 .env.example）");
  client = new OpenAI({ apiKey: key, baseURL: "https://api.deepseek.com" });
  return client;
}

/** 文本补全。 */
export async function complete(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
}): Promise<string> {
  const res = await getClient().chat.completions.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    // DeepSeek JSON 模式：要求 prompt 内含 "json" 字样（本项目 prompt 已满足）。
    ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
  });
  return res.choices[0]?.message?.content ?? "";
}

/** 期望 JSON 对象输出：用 JSON 模式，解析后返回。 */
export async function completeJSON<T>(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  // DeepSeek 偶尔返回非 JSON / 截断 → 重试至多 3 次，避免单次抖动让整条夜跑失败。
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await complete({ ...opts, json: true });
    last = text;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text.slice(text.search(/[[{]/));
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* 重试 */
    }
  }
  throw new Error(`DeepSeek 未返回可解析 JSON（重试 3 次后）：\n${last.slice(0, 500)}`);
}
