import type { NormalizedItem } from "../../lib/types.ts";

export const OPENREVIEW_DISABLED_REASON =
  "OpenReview source disabled: authenticated, venue-scoped submission access and a documented quota are required";

/**
 * Fail closed if this adapter is called accidentally. Anonymous `/notes` access currently
 * returns a bot challenge and an all-notes query cannot distinguish submissions safely.
 */
export async function fetchOpenReview(): Promise<NormalizedItem[]> {
  throw new Error(OPENREVIEW_DISABLED_REASON);
}
