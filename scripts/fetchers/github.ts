import { httpJSON, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { GITHUB_TOPICS, LOOKBACK_DAYS, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";

// GitHub search 不接受 qualifier 之间用裸 OR（会 422）—— 因此每个 topic 单独查再合并。
async function searchTopic(topic: string, since: string, perPage: number): Promise<any[]> {
  const q = `topic:${topic} pushed:>=${since}`;
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
    `&sort=stars&order=desc&per_page=${perPage}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const data = await httpJSON<{ items?: any[] }>(url, { headers });
  return toArray<any>(data?.items);
}

export async function fetchGitHub(): Promise<NormalizedItem[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const perPage = Math.ceil(PER_SOURCE_LIMIT.github / GITHUB_TOPICS.length) + 2;

  const settled = await Promise.allSettled(GITHUB_TOPICS.map((t) => searchTopic(t, since, perPage)));
  const byId = new Map<string, NormalizedItem>();
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(`[github] 跳过 topic:${GITHUB_TOPICS[i]}：${(r.reason as Error)?.message ?? r.reason}`);
      return;
    }
    for (const repo of r.value) {
      const id = String(repo.id);
      if (byId.has(id)) continue;
      byId.set(id, {
        source: "github",
        externalId: id,
        url: String(repo.html_url ?? ""),
        title: clean(repo.full_name),
        authors: [clean(repo.owner?.login)].filter(Boolean),
        abstract: clean(repo.description),
        publishedAt: String(repo.pushed_at ?? repo.created_at ?? ""),
        signals: {
          sourceWeight: SOURCE_WEIGHTS.github,
          stars: Number(repo.stargazers_count ?? 0),
          language: clean(repo.language),
        },
      });
    }
  });

  return [...byId.values()]
    .sort((a, b) => Number(b.signals.stars) - Number(a.signals.stars))
    .slice(0, PER_SOURCE_LIMIT.github);
}
