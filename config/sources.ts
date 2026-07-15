// 采集源配置 —— 复用 `播客源清单.md` 的「清单 + 权重」思路。
// sourceWeight 在排名时作为先验：官方大厂 blog / 高赞 HF 论文权重更高。

export const SOURCE_WEIGHTS: Record<string, number> = {
  arxiv: 1.0,
  huggingface: 1.2, // 带 upvotes，社区已初筛
  github: 0.9,
  blog: 1.3, // 大厂官方一手信息
  acl: 1.15, // ACL Anthology 官方精选 venue 元数据
  openalex: 0.95,
};

export interface SourceRegistryEntry {
  id: "arxiv" | "huggingface" | "github" | "blog" | "acl" | "openalex";
  officialUrl: string;
  robots: "honor";
  rateLimit: string;
  license: string;
  retention: string;
  healthContract: string;
}

/** Operational/source-compliance metadata kept next to the active registry. */
export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    id: "arxiv",
    officialUrl: "https://arxiv.org/",
    robots: "honor",
    rateLimit: "one combined RSS request per run",
    license: "arXiv terms and source metadata attribution",
    retention: "metadata and bounded abstract only",
    healthContract: "valid RSS/Atom schema and at least one structurally valid entry when upstream publishes",
  },
  {
    id: "huggingface",
    officialUrl: "https://huggingface.co/papers",
    robots: "honor",
    rateLimit: "one public Daily Papers request per run",
    license: "Hugging Face terms; retain source attribution",
    retention: "metadata and bounded abstract only",
    healthContract: "JSON array with stable paper id and non-empty title",
  },
  {
    id: "github",
    officialUrl: "https://docs.github.com/en/rest/search/search",
    robots: "honor",
    rateLimit: "GitHub API quota; token recommended",
    license: "repository-specific license; no source code mirror",
    retention: "repository metadata and description only",
    healthContract: "valid search JSON; failed topics are logged and excluded from candidates",
  },
  {
    id: "blog",
    officialUrl: "https://research.google/blog/",
    robots: "honor",
    rateLimit: "feed cadence and HTTP retry policy",
    license: "publisher terms; retain link and attribution",
    retention: "feed metadata and bounded summary only",
    healthContract: "valid RSS/Atom/sitemap XML from an allowlisted HTTPS host and path",
  },
  {
    id: "acl",
    officialUrl: "https://aclanthology.org/papers/index.xml",
    robots: "honor",
    rateLimit: "one official papers RSS request per run; 2 MiB response cap",
    license: "ACL Anthology metadata; post-2016 materials CC BY 4.0; retain attribution",
    retention: "bibliographic metadata and bounded feed description only",
    healthContract: "valid RSS with canonical aclanthology.org paper ids, selected venues, and parseable dates",
  },
  {
    id: "openalex",
    officialUrl: "https://developers.openalex.org/api-reference/authentication",
    robots: "honor",
    rateLimit: "one bounded list/filter request per run; free API key recommended by OpenAlex",
    license: "OpenAlex terms; retain source attribution",
    retention: "bibliographic metadata and abstract only",
    healthContract: "JSON results array with valid work objects; 4 MiB response cap and bounded date filter",
  },
] as const;

export interface DisabledSourceRegistryEntry {
  id: "openreview";
  state: "disabled";
  anonymousStatus: 403;
  failureMode: string;
  activationRequirements: readonly string[];
}

/** Sources that must not be counted as healthy or wired into the active fetcher list. */
export const DISABLED_SOURCE_REGISTRY: readonly DisabledSourceRegistryEntry[] = [
  {
    id: "openreview",
    state: "disabled",
    anonymousStatus: 403,
    failureMode: "excluded from the active registry and fetchers; direct adapter calls fail closed",
    activationRequirements: [
      "authenticated venue-scoped invitation",
      "submission-only schema validation",
      "documented bounded quota",
      "live health canary",
    ],
  },
] as const;

// arXiv 分类：覆盖 AI / NLP / ML / CV / 统计ML，并补充检索与多智能体。
export const ARXIV_CATEGORIES = [
  "cs.AI",
  "cs.CL",
  "cs.LG",
  "cs.CV",
  "stat.ML",
  "cs.IR",
  "cs.MA",
];

// github 主题关键词（OR 连接）。
export const GITHUB_TOPICS = ["llm", "large-language-models", "agent", "rag", "diffusion-models"];

// ACL 官方定义的核心会议与期刊；不把 workshop 全量误计为精选会议。
export const ACL_SELECTED_VENUES = [
  "acl",
  "emnlp",
  "naacl",
  "eacl",
  "aacl",
  "conll",
  "tacl",
  "cl",
] as const;

// 大厂 / 高质量官方 blog 的 RSS/Atom feed 或一方 sitemap。
// 页面补抓只允许声明的 HTTPS 主机，并拒绝自动重定向。
export interface BlogSource {
  publisher: string;
  url: string;
  kind: "feed" | "sitemap";
  pageHosts: readonly string[];
  allowedPathPrefixes?: readonly string[];
}

export const BLOG_FEEDS: readonly BlogSource[] = [
  { publisher: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", kind: "feed", pageHosts: ["huggingface.co"] },
  { publisher: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", kind: "feed", pageHosts: ["deepmind.google"] },
  { publisher: "Google Research", url: "https://research.google/blog/rss/", kind: "feed", pageHosts: ["research.google"] },
  { publisher: "OpenAI", url: "https://openai.com/news/rss.xml", kind: "feed", pageHosts: ["openai.com"] },
  { publisher: "Anthropic", url: "https://www.anthropic.com/sitemap.xml", kind: "sitemap", pageHosts: ["anthropic.com"], allowedPathPrefixes: ["/news/"] },
  { publisher: "BAIR", url: "https://bair.berkeley.edu/blog/feed.xml", kind: "feed", pageHosts: ["bair.berkeley.edu"] },
  { publisher: "Apple Machine Learning Research", url: "https://machinelearning.apple.com/rss.xml", kind: "feed", pageHosts: ["machinelearning.apple.com"], allowedPathPrefixes: ["/research/"] },
  { publisher: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/blog/feed/", kind: "feed", pageHosts: ["microsoft.com"], allowedPathPrefixes: ["/en-us/research/blog/"] },
];

// 每源候选上限，控制送进排名的候选池规模（~100）。
export const PER_SOURCE_LIMIT = {
  arxiv: 30,
  huggingface: 40,
  github: 25,
  blog: 8, // 每个 feed
  acl: 24,
  openalex: 20,
} as const;

// GitHub 查询窗口与 ingest runner 的统一新鲜度门禁共用该天数。
export const LOOKBACK_DAYS = 2;
