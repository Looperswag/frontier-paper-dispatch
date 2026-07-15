import { describe, expect, test } from "vitest";
import {
  apiError,
  apiJSON,
  apiLLMBudgetExhausted,
  apiRateLimited,
  hardenAPIResponse,
} from "@/lib/api-response";

describe("shared private API responses", () => {
  test("uses a fixed non-leaking JSON error envelope", async () => {
    const response = apiError(503, "SERVICE_UNAVAILABLE");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" },
      ok: false,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("merges Vary case-insensitively without discarding existing dimensions", () => {
    const response = hardenAPIResponse(
      new Response(null, { headers: { Vary: "Accept-Encoding, cookie, ORIGIN" } }),
    );
    const vary = response.headers.get("Vary")?.split(",").map((value) => value.trim()) ?? [];

    expect(vary.map((value) => value.toLowerCase())).toEqual([
      "accept-encoding",
      "cookie",
      "origin",
    ]);
  });

  test("hardens successful JSON responses too", async () => {
    const response = apiJSON({ ok: true }, 201);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  test.each([
    ["valid", 37, "37"],
    ["zero", 0, "1"],
    ["negative", -20, "1"],
    ["fractional", 1.5, "1"],
    ["non-finite", Number.POSITIVE_INFINITY, "1"],
    ["oversized", 999_999, "86400"],
  ])("returns a fixed rate-limit envelope with a bounded %s Retry-After", async (
    _name,
    retryAfter,
    expected,
  ) => {
    const response = apiRateLimited(retryAfter);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(expected);
    await expect(response.json()).resolves.toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
      ok: false,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  test("returns the hard LLM budget delay without exposing counters", async () => {
    const response = apiLLMBudgetExhausted(1_234);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1234");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "LLM_BUDGET_EXHAUSTED",
        message: "Daily LLM budget exhausted",
      },
      ok: false,
    });
  });
});
