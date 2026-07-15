import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SummarizedItem } from "../../lib/types.ts";
import { verifyFeedbackToken } from "../../lib/feedback-token.ts";
import { withRuntimeEnvironment } from "../../lib/runtime-env.ts";
import { renderDigest } from "../../scripts/digest.ts";

const secret = "f".repeat(40);
const webBaseURL = "https://papers.example.com";
const itemId = "00000000-0000-4000-8000-000000000001";
const item: SummarizedItem = {
  abstract: "abstract",
  authors: ["author"],
  externalId: "paper-1",
  impactMd: "impact",
  oneLiner: "one line",
  publishedAt: "2026-07-13T00:00:00.000Z",
  rank: 1,
  rationale: "reason",
  score: 99,
  signals: {},
  source: "arxiv",
  summaryMd: "summary",
  title: "Paper",
  url: "https://example.com/paper",
};

function render(environment: Record<string, string | undefined> = {}) {
  return withRuntimeEnvironment(
    { FEEDBACK_SECRET: secret, WEB_BASE_URL: webBaseURL, ...environment },
    () => renderDigest("2026-07-13", [item], new Map([["arxiv:paper-1", itemId]])),
  );
}

describe("digest feedback confirmation links", () => {
  test("issues deterministic owner-confirmed up/down capabilities", () => {
    const first = render();
    const second = render();
    const links = [...first.matchAll(/\((https:\/\/papers\.example\.com\/feedback\?token=[^)]+)\)/g)]
      .map((match) => match[1]);

    expect(first).toBe(second);
    expect(links).toHaveLength(2);
    expect(first).not.toContain("/api/feedback");
    expect(first).not.toContain(secret);
    expect(first).toContain("登录后确认");
    expect(
      links.map((link) => {
        const token = new URL(link).searchParams.get("token") as string;
        return verifyFeedbackToken(secret, token, 0);
      }),
    ).toEqual([
      expect.objectContaining({ digestDate: "2026-07-13", itemId, rating: "up" }),
      expect.objectContaining({ digestDate: "2026-07-13", itemId, rating: "down" }),
    ]);
  });

  test("fails closed instead of emitting partial links without config or an item mapping", () => {
    expect(() => render({ FEEDBACK_SECRET: undefined, WEB_BASE_URL: undefined })).toThrow(
      /FEEDBACK_SECRET|WEB_BASE_URL/,
    );
    expect(() =>
      withRuntimeEnvironment(
        { FEEDBACK_SECRET: secret, WEB_BASE_URL: webBaseURL },
        () => renderDigest("2026-07-13", [item], new Map()),
      ),
    ).toThrow(/mapping/i);
  });

  test("removes every legacy click-to-write compatibility claim", () => {
    const contract = [
      readFileSync(".env.example", "utf8"),
      readFileSync("web/.env.example", "utf8"),
      readFileSync("web/app/api/feedback/route.ts", "utf8"),
    ].join("\n");

    expect(contract).not.toMatch(/免登录|反馈一键链接|Optional signed feedback links|legacy signed-feedback|历史签名反馈兼容|FB-01 前/i);
  });
});
