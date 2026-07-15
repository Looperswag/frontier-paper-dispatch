import { LOOKBACK_DAYS } from "../config/sources.ts";
import type { NormalizedItem } from "./types.ts";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type FreshnessRejection = "missing" | "invalid" | "stale" | "future";

export function sourceFreshness(
  publishedAt: string,
  now: Date,
  lookbackDays = LOOKBACK_DAYS,
): { fresh: true; instant: Date } | { fresh: false; reason: FreshnessRejection } {
  if (!publishedAt.trim()) return { fresh: false, reason: "missing" };
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return { fresh: false, reason: "invalid" };
  const instant = new Date(timestamp);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid source freshness clock");
  if (timestamp > nowMs + MAX_CLOCK_SKEW_MS) return { fresh: false, reason: "future" };
  if (timestamp < nowMs - lookbackDays * 86_400_000) return { fresh: false, reason: "stale" };
  return { fresh: true, instant };
}

export function filterFreshItems(
  items: readonly NormalizedItem[],
  now: Date,
  onReject?: (item: NormalizedItem, reason: FreshnessRejection) => void,
): NormalizedItem[] {
  return items.flatMap((item) => {
    const result = sourceFreshness(item.publishedAt, now);
    if (!result.fresh) {
      onReject?.(item, result.reason);
      return [];
    }
    return [{ ...item, publishedAt: result.instant.toISOString() }];
  });
}
