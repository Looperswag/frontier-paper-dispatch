import { httpJSON, clean } from "../../lib/http.ts";
import { toArray } from "../../lib/normalize.ts";
import { GITHUB_TOPICS, LOOKBACK_DAYS, PER_SOURCE_LIMIT, SOURCE_WEIGHTS } from "../../config/sources.ts";
import type { NormalizedItem } from "../../lib/types.ts";
import { loadRootConfig } from "../../lib/runtime-config.ts";
import { currentRuntimeEnvironment } from "../../lib/runtime-env.ts";

interface GitHubSearchResponse {
  items: any[];
}

export function validateGitHubSearch(value: unknown): GitHubSearchResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
    throw new Error("GitHub search response must contain an items array");
  }
  const items = (value as { items: unknown[] }).items;
  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new Error("GitHub search response contains an invalid repository");
    }
    const repository = item as Record<string, unknown>;
    const hasId =
      (typeof repository.id === "number" && Number.isFinite(repository.id)) ||
      (typeof repository.id === "string" && repository.id.trim().length > 0);
    if (
      !hasId ||
      typeof repository.full_name !== "string" ||
      !repository.full_name.trim() ||
      typeof repository.html_url !== "string" ||
      !repository.html_url.trim()
    ) {
      throw new Error("GitHub search response contains an incomplete repository");
    }
  }
  return value as GitHubSearchResponse;
}

interface GitHubRelease { published_at?: unknown; tag_name?: unknown; html_url?: unknown }

function validateGitHubRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== "object") throw new Error("GitHub release response is invalid");
  return value as GitHubRelease;
}

// GitHub search 不接受 qualifier 之间用裸 OR（会 422）—— 因此每个 topic 单独查再合并。
type GitHubSearchMode = "new" | "active";

async function searchTopic(topic: string, since: string, perPage: number, mode: GitHubSearchMode): Promise<any[]> {
  const q = `topic:${topic} ${mode === "new" ? "created" : "pushed"}:>=${since}`;
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
    `&sort=${mode === "new" ? "stars" : "updated"}&order=desc&per_page=${perPage}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const githubToken = loadRootConfig("dry", currentRuntimeEnvironment()).githubToken;
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const data = await httpJSON<GitHubSearchResponse>(url, { headers, validate: validateGitHubSearch });
  return toArray<any>(data.items);
}

export function githubVelocity(repo: { stargazers_count?: unknown; created_at?: unknown; pushed_at?: unknown }, now = Date.now()): number {
  const stars = Number(repo.stargazers_count ?? 0);
  const created = Date.parse(String(repo.created_at ?? ""));
  const ageDays = Number.isFinite(created) ? Math.max(1, (now - created) / 86_400_000) : 3650;
  return Number.isFinite(stars) && stars >= 0 ? stars / ageDays : 0;
}

export function orderGitHubCandidates(items: readonly NormalizedItem[]): NormalizedItem[] {
  return [...items].sort((a, b) =>
    Number(b.signals.starVelocity) - Number(a.signals.starVelocity) ||
    Number(b.signals.stars) - Number(a.signals.stars) ||
    a.externalId.localeCompare(b.externalId),
  );
}

export function applyGitHubRelease(item: NormalizedItem, release: GitHubRelease, now = Date.now()): void {
  const publishedAt = clean(release.published_at);
  const releaseTime = Date.parse(publishedAt);
  if (!Number.isFinite(releaseTime) || releaseTime > now + 5 * 60_000) return;
  const activityTime = Date.parse(item.publishedAt);
  if (!Number.isFinite(activityTime) || releaseTime > activityTime) item.publishedAt = publishedAt;
  item.signals = {
    ...item.signals,
    release: clean(release.tag_name),
    releasePublishedAt: publishedAt,
    releaseUrl: clean(release.html_url),
  };
}

export function combineGitHubSearchResults(
  results: readonly PromiseSettledResult<any[]>[],
  topics: readonly string[],
  logger: Pick<Console, "warn"> = console,
): any[] {
  if (!topics.length || results.length !== topics.length * 2) {
    throw new Error("GitHub search result contract mismatch");
  }
  const repositories: any[] = [];
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      repositories.push(...result.value);
      return;
    }
    failures.push(result.reason);
    logger.warn(
      `[github] 跳过 topic:${topics[Math.floor(index / 2)]}：${(result.reason as Error)?.message ?? result.reason}`,
    );
  });
  if (failures.length === results.length) {
    throw new AggregateError(failures, "all GitHub repository searches failed");
  }
  return repositories;
}

export async function fetchGitHub(): Promise<NormalizedItem[]> {
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const perPage = Math.ceil(PER_SOURCE_LIMIT.github / GITHUB_TOPICS.length) + 2;

  const settled = await Promise.allSettled(
    GITHUB_TOPICS.flatMap((topic) => [
      searchTopic(topic, since, Math.ceil(perPage / 2), "new"),
      searchTopic(topic, since, Math.ceil(perPage / 2), "active"),
    ]),
  );
  const byId = new Map<string, NormalizedItem>();
  for (const repo of combineGitHubSearchResults(settled, GITHUB_TOPICS)) {
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
        starVelocity: githubVelocity(repo, now),
        isNew: Date.parse(String(repo.created_at ?? "")) >= now - LOOKBACK_DAYS * 86_400_000 ? 1 : 0,
        pushedAt: String(repo.pushed_at ?? ""),
        language: clean(repo.language),
      },
    });
  }

  const candidates = orderGitHubCandidates([...byId.values()]);
  const githubToken = loadRootConfig("dry", currentRuntimeEnvironment()).githubToken;
  const releases = await Promise.allSettled(candidates.slice(0, 10).map(async (item) => {
    const repo = item.url.match(/github\.com\/([^/]+\/[^/?#]+)/i)?.[1];
    if (!repo) return undefined;
    const release = await httpJSON(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}) },
      validate: validateGitHubRelease,
      maxAttempts: 1,
      timeoutMs: 8_000,
      deadlineMs: 10_000,
    });
    return { item, release };
  }));
  releases.forEach((result) => {
    if (result.status !== "fulfilled" || !result.value) return;
    applyGitHubRelease(result.value.item, result.value.release, now);
  });
  return orderGitHubCandidates(candidates).slice(0, PER_SOURCE_LIMIT.github);
}
