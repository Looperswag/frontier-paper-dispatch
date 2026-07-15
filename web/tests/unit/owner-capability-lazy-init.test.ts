import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OwnerContext } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getDataConfig: vi.fn(),
  getLLMConfig: vi.fn(),
  openAIConstructor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/config.server", () => ({
  getDataConfig: mocks.getDataConfig,
  getLLMConfig: mocks.getLLMConfig,
}));
vi.mock("openai", () => ({
  default: class TestOpenAI {
    readonly provider = "deepseek";

    constructor(options: unknown) {
      mocks.openAIConstructor(options);
    }
  },
}));

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
} as unknown as OwnerContext;

function emptyDigestDatabase() {
  return { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
}

beforeEach(() => {
  vi.resetModules();
  mocks.createClient.mockReset();
  mocks.getDataConfig.mockReset().mockReturnValue({
    serviceRoleKey: "service-role-key",
    url: "https://project.supabase.co",
  });
  mocks.getLLMConfig.mockReset().mockReturnValue({
    apiKey: "deepseek-key",
    baseURL: "https://api.deepseek.com",
  });
  mocks.openAIConstructor.mockReset();
});

describe("owner capability activates privileged clients lazily", () => {
  test("importing the DAL and LLM modules does not read secrets or create clients", async () => {
    await import("@/lib/data");
    await import("@/lib/llm");

    expect(mocks.getDataConfig).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getLLMConfig).not.toHaveBeenCalled();
    expect(mocks.openAIConstructor).not.toHaveBeenCalled();
  });

  test("input rejected before a database operation cannot activate the admin client", async () => {
    const { getPaper, searchPapers } = await import("@/lib/data");

    await expect(getPaper(owner, "not-a-uuid")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
    });
    await expect(searchPapers(owner, "   ")).resolves.toEqual([]);
    expect(mocks.getDataConfig).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  test("a valid owner operation creates and reuses exactly one admin client", async () => {
    const database = emptyDigestDatabase();
    mocks.createClient.mockReturnValue(database);
    const { getTop5 } = await import("@/lib/data");

    await expect(getTop5(owner)).resolves.toEqual({ date: null, papers: [] });
    await expect(getTop5(owner)).resolves.toEqual({ date: null, papers: [] });

    expect(mocks.getDataConfig).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "service-role-key",
      { auth: { persistSession: false } },
    );
    expect(database.rpc).toHaveBeenCalledTimes(2);
    expect(database.rpc).toHaveBeenCalledWith("get_latest_digest_bundle");
  });

  test("the LLM client is only created when invoked with an owner capability", async () => {
    const { deepseek } = await import("@/lib/llm");

    expect(deepseek(owner)).toEqual({ provider: "deepseek" });
    expect(mocks.getLLMConfig).toHaveBeenCalledTimes(1);
    expect(mocks.openAIConstructor).toHaveBeenCalledWith({
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
      maxRetries: 0,
      timeout: 45_000,
    });
  });
});
