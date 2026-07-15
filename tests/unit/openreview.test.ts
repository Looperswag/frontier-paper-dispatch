import { expect, test } from "vitest";
import { fetchOpenReview, OPENREVIEW_DISABLED_REASON } from "../../scripts/fetchers/openreview.ts";

test("OpenReview adapter fails closed instead of calling the anonymous all-notes endpoint", async () => {
  expect(OPENREVIEW_DISABLED_REASON).toMatch(/authenticated.*venue-scoped/i);
  await expect(fetchOpenReview()).rejects.toThrow(/disabled/i);
});
