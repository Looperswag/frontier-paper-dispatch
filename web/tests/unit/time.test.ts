import { describe, expect, test } from "vitest";
import { shanghaiDateKey } from "@/lib/time";

describe("shanghaiDateKey", () => {
  test.each([
    ["2026-07-09T15:59:59.999Z", "2026-07-09"],
    ["2026-07-09T16:00:00.000Z", "2026-07-10"],
  ])("uses Asia/Shanghai rather than the host or UTC date for %s", (instant, expected) => {
    expect(shanghaiDateKey(new Date(instant))).toBe(expected);
  });

  test("rejects invalid dates instead of creating malformed keys", () => {
    expect(() => shanghaiDateKey(new Date(Number.NaN))).toThrow(/invalid/i);
  });
});
