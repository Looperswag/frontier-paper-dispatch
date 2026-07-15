import { describe, expect, test } from "vitest";
import { validateGitHubSearch } from "../../scripts/fetchers/github.ts";
import { validateHuggingFaceDailyPapers } from "../../scripts/fetchers/huggingface.ts";

describe("provider JSON contracts", () => {
  test("accepts the expected GitHub and Hugging Face top-level shapes", () => {
    expect(validateGitHubSearch({ items: [] })).toEqual({ items: [] });
    expect(validateHuggingFaceDailyPapers([])).toEqual([]);
    expect(
      validateGitHubSearch({
        items: [{ id: 1, full_name: "owner/repo", html_url: "https://github.com/owner/repo" }],
      }),
    ).toBeTruthy();
    expect(
      validateHuggingFaceDailyPapers([{ paper: { id: "2607.00001", title: "A paper" } }]),
    ).toBeTruthy();
  });

  test.each([
    ["GitHub", () => validateGitHubSearch({ message: "rate limit fallback" })],
    ["Hugging Face", () => validateHuggingFaceDailyPapers({ error: "fallback" })],
  ])("rejects a 200 %s business-error fallback", (_provider, validate) => {
    expect(validate).toThrow(/response/i);
  });

  test.each([
    ["GitHub null item", () => validateGitHubSearch({ items: [null] })],
    ["GitHub missing identity", () => validateGitHubSearch({ items: [{ name: "repo" }] })],
    ["Hugging Face null item", () => validateHuggingFaceDailyPapers([null])],
    ["Hugging Face null paper", () => validateHuggingFaceDailyPapers([{ paper: null }])],
    ["Hugging Face missing identity", () => validateHuggingFaceDailyPapers([{ paper: { title: "Untitled" } }])],
  ])("rejects a malformed %s before provider mapping", (_name, validate) => {
    expect(validate).toThrow(/response/i);
  });
});
