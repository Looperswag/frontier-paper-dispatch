import { expect, test } from "vitest";
import { ndcgAtK, precisionAtK } from "../../lib/ranking-metrics.ts";

test("offline ranking metrics are bounded and deterministic", () => {
  expect(precisionAtK([true, false, true], 2)).toBe(0.5);
  expect(ndcgAtK([3, 2, 1], 3)).toBe(1);
  expect(ndcgAtK([1, 0, 3], 3)).toBeLessThan(1);
  expect(ndcgAtK([], 5)).toBe(0);
});
