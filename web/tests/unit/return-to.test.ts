import { describe, expect, test } from "vitest";
import { MAX_RETURN_TO_BYTES, normalizeReturnTo } from "@/lib/return-to";

function encodePercentLayers(value: string, count: number): string {
  let encoded = value;
  for (let layer = 0; layer < count; layer += 1) encoded = encoded.replaceAll("%", "%25");
  return encoded;
}

describe("safe owner login returnTo", () => {
  test.each([
    "/",
    "/feedback?token=v1_example-token_123",
    "/paper/00000000-0000-4000-8000-000000000001?from=digest&mode=compact",
    "/search?q=%E8%AE%BA%E6%96%87",
  ])("keeps an internal page path and query: %s", (value) => {
    expect(normalizeReturnTo(value)).toBe(value);
  });

  test("accepts exactly 4096 UTF-8 bytes and rejects one byte more", () => {
    const exact = `/${"a".repeat(MAX_RETURN_TO_BYTES - 1)}`;
    const over = `${exact}a`;

    expect(new TextEncoder().encode(exact)).toHaveLength(MAX_RETURN_TO_BYTES);
    expect(normalizeReturnTo(exact)).toBe(exact);
    expect(normalizeReturnTo(over)).toBe("/");
  });

  test("uses UTF-8 bytes, rather than JavaScript code units, at the 4096-byte boundary", () => {
    const exact = `/${"界".repeat((MAX_RETURN_TO_BYTES - 1) / 3)}`;
    const over = `${exact}a`;

    expect(new TextEncoder().encode(exact)).toHaveLength(MAX_RETURN_TO_BYTES);
    expect(normalizeReturnTo(exact)).toBe(exact);
    expect(new TextEncoder().encode(over)).toHaveLength(MAX_RETURN_TO_BYTES + 1);
    expect(normalizeReturnTo(over)).toBe("/");
  });

  test("rejects protected routes hidden under an arbitrary number of percent layers", () => {
    const deeplyEncodedApi = `/${encodePercentLayers("%61", 32)}pi/private`;
    const deeplyEncodedBackslash = `/${encodePercentLayers("%5c", 32)}attacker.example`;

    expect(normalizeReturnTo(deeplyEncodedApi)).toBe("/");
    expect(normalizeReturnTo(deeplyEncodedBackslash)).toBe("/");
  });

  test("fails closed instead of recursively processing excessive encoding depth", () => {
    const excessivelyEncodedPage = `/paper/${encodePercentLayers("%61", 32)}`;

    expect(normalizeReturnTo(excessivelyEncodedPage)).toBe("/");
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["array", ["/paper/one", "/paper/two"]],
    ["empty", ""],
    ["relative", "paper/one"],
    ["absolute https", "https://attacker.example/steal"],
    ["absolute javascript", "javascript:alert(1)"],
    ["protocol relative", "//attacker.example/steal"],
    ["triple slash", "///attacker.example/steal"],
    ["literal backslash", "/\\attacker.example/steal"],
    ["encoded backslash", "/%5cattacker.example/steal"],
    ["uppercase encoded backslash", "/%5Cattacker.example/steal"],
    ["double encoded backslash", "/%255cattacker.example/steal"],
    ["triple encoded backslash", "/%25255cattacker.example/steal"],
    ["encoded protocol relative", "/%2f%2fattacker.example/steal"],
    ["double encoded protocol relative", "/%252f%252fattacker.example/steal"],
    ["double encoded dot path to protocol relative", "/%252e%252e//attacker.example/steal"],
    ["literal control", "/paper\u0000/one"],
    ["literal DEL", "/paper\u007f/one"],
    ["literal C1 control", "/paper\u0085/one"],
    ["encoded control", "/paper%0d%0aSet-Cookie:evil"],
    ["double encoded control", "/paper%250d%250aSet-Cookie:evil"],
    ["encoded DEL", "/paper%7F/one"],
    ["double encoded DEL", "/paper%257F/one"],
    ["encoded C1 control", "/paper%C2%85/one"],
    ["encoded C1 CSI", "/paper%C2%9B/one"],
    ["literal fragment", "/paper/one#private"],
    ["encoded fragment", "/paper/one%23private"],
    ["malformed escape", "/paper/%"],
    ["encoded malformed escape", "/paper/%25G0"],
    ["double encoded malformed escape", "/paper/%2525G0"],
    ["encoded truncated escape", "/paper/%252"],
    ["invalid UTF-8 escape", "/paper/%c0%aflogin"],
    ["API root", "/api"],
    ["API route", "/api/feedback?token=secret"],
    ["encoded API route", "/a%70i/feedback"],
    ["triple encoded API route", "/%252561pi/feedback"],
    ["dot-normalized API route", "/paper/../api/feedback"],
    ["login root", "/login"],
    ["login child", "/login/extra"],
    ["encoded login", "/l%6fgin"],
    ["Next root", "/_next"],
    ["Next asset", "/_next/static/chunk.js"],
    ["encoded Next route", "/%5fnext/static/chunk.js"],
  ] as const)("falls back to home for %s", (_name, value) => {
    expect(normalizeReturnTo(value)).toBe("/");
  });
});
