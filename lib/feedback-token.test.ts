import { describe, expect, test } from "vitest";
import {
  feedbackTokenFingerprint,
  issueFeedbackToken,
  verifyFeedbackToken,
} from "./feedback-token.ts";
import fixture from "../tests/fixtures/feedback-token-v1.json";

const secret = "feedback-secret-with-at-least-thirty-two-bytes";
const input = {
  digestDate: "2026-07-13",
  itemId: "abcdef12-3456-4789-8abc-def012345678",
  rating: "up" as const,
};

describe("versioned one-time feedback token codec", () => {
  test("matches the independently frozen cross-project fixture", () => {
    expect(
      issueFeedbackToken(fixture.secret, {
        digestDate: fixture.digestDate,
        itemId: fixture.itemId,
        rating: "up",
      }),
    ).toBe(fixture.up);
    expect(
      issueFeedbackToken(fixture.secret, {
        digestDate: fixture.digestDate,
        itemId: fixture.itemId,
        rating: "down",
      }),
    ).toBe(fixture.down);
  });

  test.each(["2000-01-01", "2287-01-01"])(
    "round-trips canonical expiry widths for digest date %s",
    (digestDate) => {
      const token = issueFeedbackToken(secret, { ...input, digestDate });

      expect(verifyFeedbackToken(secret, token, 0)).toMatchObject({ digestDate });
    },
  );

  test("issues a deterministic canonical token and verifies all signed claims", () => {
    const token = issueFeedbackToken(secret, input);

    expect(issueFeedbackToken(secret, input)).toBe(token);
    expect(token).toMatch(
      /^v1\.2026-07-13\.abcdef12-3456-4789-8abc-def012345678\.up\.\d{10}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(
      verifyFeedbackToken(secret, token, new Date("2026-08-03T15:59:59.000Z")),
    ).toEqual({
      digestDate: input.digestDate,
      expiresAt: Date.parse("2026-08-03T16:00:00.000Z") / 1_000,
      itemId: input.itemId,
      nonce: token.split(".")[5],
      rating: "up",
      version: "v1",
    });
  });

  test("shares one deterministic nonce across the two choices for one digest item", () => {
    const up = issueFeedbackToken(secret, input).split(".");
    const down = issueFeedbackToken(secret, { ...input, rating: "down" }).split(".");

    expect(up[5]).toBe(down[5]);
    expect(up[6]).not.toBe(down[6]);
    expect(issueFeedbackToken(secret, { ...input, digestDate: "2026-07-14" }).split(".")[5])
      .not.toBe(up[5]);
    expect(
      issueFeedbackToken(secret, {
        ...input,
        itemId: "abcdef12-3456-4789-8abc-def012345679",
      }).split(".")[5],
    ).not.toBe(up[5]);
  });

  test("expires exactly at the fixed boundary and rejects invalid clocks", () => {
    const token = issueFeedbackToken(secret, input);

    expect(verifyFeedbackToken(secret, token, new Date("2026-08-03T15:59:59.999Z"))).toBeDefined();
    expect(verifyFeedbackToken(secret, token, new Date("2026-08-03T16:00:00.000Z"))).toBeUndefined();
    expect(verifyFeedbackToken(secret, token, new Date("invalid"))).toBeUndefined();
  });

  test.each([
    ["version", 0, "v2"],
    ["date", 1, "2026-07-14"],
    ["item", 2, "abcdef12-3456-4789-8abc-def012345679"],
    ["rating", 3, "down"],
    ["expiry", 4, "1999999999"],
    ["nonce", 5, "A".repeat(43)],
    ["signature", 6, "A".repeat(43)],
  ])("rejects a token with a mutated %s", (_name, index, replacement) => {
    const parts = issueFeedbackToken(secret, input).split(".");
    parts[index] = replacement;

    expect(verifyFeedbackToken(secret, parts.join("."), new Date("2026-07-13T00:00:00Z")))
      .toBeUndefined();
  });

  test.each([
    "",
    "0123456789abcdef",
    "v1.too.few.fields",
    `v1.2026-07-13.${input.itemId}.up.1785772800.${"!".repeat(43)}.${"A".repeat(43)}`,
    `v1.2026-07-13.${input.itemId}.up.01785772800.${"A".repeat(43)}.${"A".repeat(43)}`,
    `v1.2026-07-13.${input.itemId.toUpperCase()}.up.1785772800.${"A".repeat(43)}.${"A".repeat(43)}`,
  ])("rejects malformed or legacy token %s", (token) => {
    expect(verifyFeedbackToken(secret, token, new Date("2026-07-13T00:00:00Z"))).toBeUndefined();
  });

  test.each([
    { ...input, digestDate: "2026-02-30" },
    { ...input, digestDate: "1969-12-01" },
    { ...input, itemId: input.itemId.toUpperCase() },
    { ...input, itemId: "not-a-uuid" },
    { ...input, rating: "maybe" as "up" },
  ])("refuses to sign noncanonical claims", (claims) => {
    expect(() => issueFeedbackToken(secret, claims)).toThrow("Invalid feedback token claims");
  });

  test("requires a strong secret and produces stable non-token fingerprints", () => {
    const token = issueFeedbackToken(secret, input);

    expect(() => issueFeedbackToken("too-short", input)).toThrow("Invalid feedback token secret");
    expect(verifyFeedbackToken("too-short", token, new Date("2026-07-13T00:00:00Z")))
      .toBeUndefined();
    expect(feedbackTokenFingerprint(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(feedbackTokenFingerprint(token)).toBe(feedbackTokenFingerprint(token));
    expect(feedbackTokenFingerprint(`${token}x`)).not.toBe(feedbackTokenFingerprint(token));
    expect(feedbackTokenFingerprint(token)).not.toContain(token);
  });
});
