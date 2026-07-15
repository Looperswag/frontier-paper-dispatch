import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fixture from "../../../tests/fixtures/feedback-token-v1.json";

const mocks = vi.hoisted(() => ({
  getFeedbackConfig: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config.server", () => ({ getFeedbackConfig: mocks.getFeedbackConfig }));

import { verifyFeedbackToken } from "@/lib/sign";

beforeEach(() => {
  mocks.getFeedbackConfig.mockReset().mockReturnValue({ secret: fixture.secret });
});

describe("Web feedback token verifier cross-contract", () => {
  test.each([
    ["up", fixture.up],
    ["down", fixture.down],
  ])("verifies the frozen %s fixture and returns frozen claims", (rating, token) => {
    const claims = verifyFeedbackToken(token, (fixture.expiresAt - 1) * 1_000);

    expect(claims).toEqual({
      digestDate: fixture.digestDate,
      expiresAt: fixture.expiresAt,
      itemId: fixture.itemId,
      nonce: fixture.nonce,
      rating,
      version: "v1",
    });
    expect(Object.isFrozen(claims)).toBe(true);
  });

  test("expires at the exact signed boundary", () => {
    expect(verifyFeedbackToken(fixture.up, fixture.expiresAt * 1_000 - 1)).toBeDefined();
    expect(verifyFeedbackToken(fixture.up, fixture.expiresAt * 1_000)).toBeUndefined();
  });

  test.each(fixture.boundaryTokens)(
    "verifies a frozen canonical token across non-10-digit expiry widths",
    (token) => {
      expect(verifyFeedbackToken(token, 0)).toMatchObject({
        digestDate: token.split(".")[1],
      });
    },
  );

  test.each([
    ["version", 0, "v2"],
    ["date", 1, "2026-07-14"],
    ["item", 2, "00000000-0000-4000-8000-000000000002"],
    ["rating", 3, "down"],
    ["expiry", 4, "1785772801"],
    ["nonce", 5, "A".repeat(43)],
    ["signature", 6, "A".repeat(43)],
  ])("rejects a mutated %s", (_name, index, replacement) => {
    const parts = fixture.up.split(".");
    parts[index] = replacement;

    expect(verifyFeedbackToken(parts.join("."), 0)).toBeUndefined();
  });

  test.each([
    "",
    "0123456789abcdef",
    "v1.too.few.fields",
    `${fixture.up}.extra`,
    `v1.${"x".repeat(300)}`,
    fixture.up.replace(fixture.itemId, "ABCDEF12-3456-4789-8ABC-DEF012345678"),
    fixture.up.replace("1785772800", "01785772800"),
    fixture.up.replace(fixture.nonce, "!".repeat(43)),
  ])("rejects malformed or legacy input without throwing", (token) => {
    expect(() => verifyFeedbackToken(token, 0)).not.toThrow();
    expect(verifyFeedbackToken(token, 0)).toBeUndefined();
  });

  test("rejects a structurally complete short MAC and retains the constant-time source contract", () => {
    const parts = fixture.up.split(".");
    parts[6] = "short";

    expect(verifyFeedbackToken(parts.join("."), 0)).toBeUndefined();
    const source = readFileSync(resolve(process.cwd(), "lib/feedback-token.ts"), "utf8");
    expect(source).toContain("const candidate = decoded ?? Buffer.alloc(32)");
    expect(source).toContain("timingSafeEqual(candidate, expected)");
    expect(source).not.toMatch(/signature\s*===|===\s*signature/);
  });

  test("does not disguise missing server configuration as a bad token", () => {
    mocks.getFeedbackConfig.mockImplementationOnce(() => {
      throw new Error("feedback configuration unavailable");
    });

    expect(() => verifyFeedbackToken(fixture.up, 0)).toThrow(
      "feedback configuration unavailable",
    );
  });
});
