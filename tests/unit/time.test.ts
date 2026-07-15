import { describe, expect, test, vi } from "vitest";
import { lockShanghaiRunTime, shanghaiDateKey } from "../../lib/time.ts";

describe("shanghaiDateKey", () => {
  test.each([
    ["2026-07-09T15:59:59.999Z", "2026-07-09"],
    ["2026-07-09T16:00:00.000Z", "2026-07-10"],
    ["2025-12-31T16:00:00.000Z", "2026-01-01"],
  ])("maps %s to the Asia/Shanghai calendar date", (instant, expected) => {
    expect(shanghaiDateKey(new Date(instant))).toBe(expected);
  });
});

describe("lockShanghaiRunTime", () => {
  test("uses the current instant when no clock is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T16:00:00.000Z"));
    try {
      expect(lockShanghaiRunTime()).toMatchObject({
        date: "2026-07-10",
        startedAt: "2026-07-09T16:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("reads the clock once so a cross-midnight run keeps one date", () => {
    const clock = vi.fn(() => new Date("2026-07-09T15:59:59.999Z"));

    const runTime = lockShanghaiRunTime(clock);

    expect(clock).toHaveBeenCalledTimes(1);
    expect(runTime).toEqual({
      date: "2026-07-09",
      startedAt: "2026-07-09T15:59:59.999Z",
      timeZone: "Asia/Shanghai",
    });
    expect(Object.isFrozen(runTime)).toBe(true);
  });

  test("rejects an invalid clock value", () => {
    expect(() => lockShanghaiRunTime(() => new Date(Number.NaN))).toThrow(/invalid/i);
  });
});
