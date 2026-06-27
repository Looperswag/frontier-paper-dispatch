// 采集源配置 —— 复用 `播客源清单.md` 的「清单 + 权重」思路。
// sourceWeight 在排名时作为先验：官方大厂 blog / 高赞 HF 论文权重更高。

export const SOURCE_WEIGHTS: Record<string, number> = {
  arxiv: 1.0,
  huggingface: 1.2, // 带 upvotes，社区已初筛
  github: 0.9,
  blog: 1.3, // 大厂官方一手信息
  x: 0.7, // best-effort
  facebook: 0.6,
};

// arxiv 分类：覆盖 AI / NLP / ML / CV / 统计ML。
export const ARXIV_CATEGORIES = ["cs.AI", "cs.CL", "cs.LG", "cs.CV", "stat.ML"];

// github 主题关键词（OR 连接）。
export const GITHUB_TOPICS = ["llm", "large-language-models", "agent", "rag", "diffusion-models"];

// 大厂 / 高质量官方 blog 的 RSS/Atom feed。
// best-effort：失效的 feed 会被 blogs fetcher 静默跳过（见 scripts/fetchers/blogs.ts）。
export const BLOG_FEEDS: { publisher: string; url: string }[] = [
  { publisher: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { publisher: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { publisher: "Google Research", url: "https://research.google/blog/rss/" },
  { publisher: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { publisher: "Anthropic", url: "https://www.anthropic.com/rss.xml" },
  { publisher: "BAIR", url: "https://bair.berkeley.edu/blog/feed.xml" },
];

// 每源候选上限，控制送进排名的候选池规模（~100）。
export const PER_SOURCE_LIMIT = {
  arxiv: 30,
  huggingface: 40,
  github: 25,
  blog: 8, // 每个 feed
} as const;

// 只要近 N 天的内容。
export const LOOKBACK_DAYS = 2;
