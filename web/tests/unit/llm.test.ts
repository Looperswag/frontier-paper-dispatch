import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OwnerContext } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  options: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config.server", () => ({ getLLMConfig: mocks.config }));
vi.mock("openai", () => ({
  default: class MockOpenAI {
    readonly chat = { completions: { create: vi.fn() } };

    constructor(options: unknown) {
      mocks.options.push(options);
    }
  },
}));

import { deepseek } from "@/lib/llm";

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
} as OwnerContext;

beforeEach(() => {
  mocks.options.length = 0;
  mocks.config.mockReset().mockReturnValue({
    apiKey: `sk-${"d".repeat(40)}`,
    baseURL: "https://api.deepseek.com",
  });
});

describe("Web DeepSeek transport", () => {
  test("disables hidden SDK retries and sets an explicit provider deadline", () => {
    deepseek(owner);

    expect(mocks.options).toEqual([
      expect.objectContaining({
        baseURL: "https://api.deepseek.com",
        maxRetries: 0,
        timeout: 45_000,
      }),
    ]);
  });
});
