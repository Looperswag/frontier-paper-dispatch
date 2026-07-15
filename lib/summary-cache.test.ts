import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase.ts", () => ({ getClient: vi.fn(async () => ({ rpc: mocks.rpc })) }));

import { getSummaryVersion, storeSummaryVersion } from "./summary-cache.ts";

const key = {
  itemId: "00000000-0000-4000-8000-000000000001",
  contentHash: "a".repeat(64),
  profileHash: "b".repeat(64),
  promptVersion: "summary-v1",
};

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe("summary cache RPC client", () => {
  test("returns a validated cached version and sends exact hash keys", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ one_liner: "One", summary_md: "Summary", impact_md: "Impact", model: "deepseek" }],
      error: null,
    });
    await expect(getSummaryVersion(key.itemId, key.contentHash, key.profileHash, key.promptVersion)).resolves.toEqual({
      oneLiner: "One",
      summaryMd: "Summary",
      impactMd: "Impact",
      model: "deepseek",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_summary_version", expect.objectContaining({
      p_item_id: key.itemId,
      p_content_hash: key.contentHash,
      p_profile_hash: key.profileHash,
      p_prompt_version: key.promptVersion,
    }));
  });

  test("stores output through the server-only RPC and validates malformed rows", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ stored: true }], error: null });
    await expect(storeSummaryVersion(key.itemId, key.contentHash, key.profileHash, key.promptVersion, {
      oneLiner: "One",
      summaryMd: "Summary",
      impactMd: "Impact",
      model: "deepseek",
    })).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("store_summary_version", expect.objectContaining({
      p_model: "deepseek",
      p_summary_md: "Summary",
    }));
    await expect(getSummaryVersion(key.itemId, "bad", key.profileHash, key.promptVersion)).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED" });
  });
});
