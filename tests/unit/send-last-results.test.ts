import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { issueFeedbackToken } from "../../lib/feedback-token.ts";

const mocks = vi.hoisted(() => {
  const state = {
    client: undefined as unknown,
    createClient: vi.fn(),
  };
  state.createClient.mockImplementation(() => state.client);
  return state;
});

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { runSendLastCommand } from "../../scripts/send-last.ts";

const activeFeedbackInstant = new Date("2026-07-13T00:00:00.000Z");
const feedbackSecret = "f".repeat(40);
const webBaseURL = "https://papers.example.com";
const itemId = "00000000-0000-4000-8000-000000000001";

function serverChanSuccess(): Response {
  return new Response(JSON.stringify({ code: 0 }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function feedbackMarkdown(
  date = "2026-07-12",
  options: { baseURL?: string; secret?: string; omitDown?: boolean } = {},
): string {
  const baseURL = options.baseURL ?? webBaseURL;
  const token = (rating: "up" | "down") =>
    issueFeedbackToken(options.secret ?? feedbackSecret, {
      digestDate: date,
      itemId,
      rating,
    });
  const link = (rating: "up" | "down") => {
    const url = new URL("/feedback", baseURL);
    url.searchParams.set("token", token(rating));
    return `[${rating === "up" ? "👍 有用" : "👎 不相关"}](${url})`;
  };
  return `# digest\n\n- 反馈：${link("up")}${options.omitDown ? "" : ` · ${link("down")}`}（登录后确认）`;
}

function digestRow(overrides: Record<string, unknown> = {}) {
  return {
    digest_date: "2026-07-12",
    rendered_md: feedbackMarkdown(),
    top5_item_ids: [itemId],
    ...overrides,
  };
}

function queryClient(response: unknown): SupabaseClient {
  return queryHarness(response).client;
}

const defaultClaim = {
  delivery_id: "00000000-0000-4000-8000-000000000001",
  digest_date: "2026-07-12",
  channel: "wechat",
  provider_id: "serverchan",
  idempotency_key: "digest:2026-07-12:wechat",
  payload: { title: "前沿论文情报台 · 2026-07-12 · Top5", markdown: feedbackMarkdown() },
  attempts: 1,
  lease_until: "2099-01-01T00:00:00Z",
};

function queryHarness(
  response: unknown,
  options: {
    claimRows?: readonly Record<string, unknown>[];
    requeueRows?: readonly Record<string, unknown>[];
  } = {},
) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {};
  for (const method of ["limit", "maybeSingle", "order", "select"] as const) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  const from = vi.fn(() => query);
  const rpc = vi.fn((name: string) => {
    if (name === "enqueue_delivery") {
      return Promise.resolve({
        data: [{
          delivery_id: "00000000-0000-4000-8000-000000000001",
          delivery_status: "pending",
          inserted: true,
        }],
        error: null,
      });
    }
    if (name === "requeue_failed_deliveries") {
      return Promise.resolve({
        data: options.requeueRows ?? [],
        error: null,
      });
    }
    if (name === "claim_digest_delivery") {
      return Promise.resolve({ data: options.claimRows ?? [defaultClaim], error: null });
    }
    if (name === "claim_delivery") return Promise.resolve({ data: [], error: null });
    return Promise.resolve({
      data: [{ delivery_id: "00000000-0000-4000-8000-000000000001", delivery_status: "succeeded", attempts: 1 }],
      error: null,
    });
  });
  return { client: { from, rpc } as unknown as SupabaseClient, from, query, rpc };
}

let environmentId = 0;
function environment(overrides: Record<string, string> = {}) {
  environmentId += 1;
  return {
    SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
    FEEDBACK_SECRET: feedbackSecret,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${String(environmentId).padStart(40, "s")}`,
    SUPABASE_URL: `https://send-last-${environmentId}.supabase.co`,
    WEB_BASE_URL: webBaseURL,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.createClient.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("send-last digest query handling", () => {
  test("returns only for a genuine no-row result", async () => {
    mocks.client = queryClient({ data: null, error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSendLastCommand(environment(), activeFeedbackInstant)).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      "数据库里还没有 digest，先跑一次 `npm run ingest`。",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("wraps a query failure without leaking provider details", async () => {
    const sentinel = "private latest-digest query detail";
    mocks.client = queryClient({
      data: null,
      error: { code: "PGRST801", message: sentinel },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await runSendLastCommand(environment(), activeFeedbackInstant).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "digests.fetchLatest",
    });
    expect(String(error)).not.toContain(sentinel);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    { digest_date: "2026-07-12", name: "empty markdown", rendered_md: "" },
    { digest_date: "2026-07-12", name: "blank markdown", rendered_md: " \n\t " },
    { digest_date: "not-a-date", name: "invalid date", rendered_md: "# digest" },
    { digest_date: "2026-02-29", name: "invalid leap day", rendered_md: "# digest" },
    { digest_date: "2026-04-31", name: "invalid month day", rendered_md: "# digest" },
    { digest_date: "0000-01-01", name: "Postgres-invalid year zero", rendered_md: "# digest" },
    { digest_date: null, name: "null date", rendered_md: "# digest" },
  ])("rejects a corrupt row with $name instead of reporting no digest", async (row) => {
    mocks.client = queryClient({ data: row, error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSendLastCommand(environment(), activeFeedbackInstant)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchLatest",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("pushes only a validated latest digest", async () => {
    const harness = queryHarness({
      data: digestRow(),
      error: null,
    });
    mocks.client = harness.client;
    const fetchMock = vi.fn().mockResolvedValue(serverChanSuccess());
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSendLastCommand(environment(), activeFeedbackInstant)).resolves.toBeUndefined();
    expect(harness.query.order).toHaveBeenCalledWith("digest_date", { ascending: false });
    expect(harness.query.select).toHaveBeenCalledWith(
      "digest_date, rendered_md, top5_item_ids",
    );
    expect(harness.query.limit).toHaveBeenCalledWith(1);
    expect(harness.query.maybeSingle).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.rpc).toHaveBeenCalledWith("requeue_failed_deliveries", expect.objectContaining({
      p_digest_date: "2026-07-12",
    }));
    expect(harness.rpc).toHaveBeenCalledWith("claim_digest_delivery", expect.objectContaining({
      p_digest_date: "2026-07-12",
    }));
    expect(harness.rpc).not.toHaveBeenCalledWith("claim_delivery", expect.anything());
    expect(console.log).toHaveBeenCalledWith("已实际投递 2026-07-12：wechat ✉️");
  });

  test("does not claim success when the target digest has no immediately claimable delivery", async () => {
    const harness = queryHarness(
      { data: digestRow(), error: null },
      { claimRows: [] },
    );
    mocks.client = harness.client;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runSendLastCommand(environment(), activeFeedbackInstant)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "2026-07-12 没有可立即重推的任务；它可能已成功或仍在等待重试。",
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("已实际投递"));
  });

  test.each([
    ["uppercase host", "https://PAPERS.EXAMPLE.COM"],
    ["default HTTPS port", "https://papers.example.com:443"],
    ["Unicode host", "https://例子.测试"],
  ])("accepts a canonicalized %s in WEB_BASE_URL", async (_name, configuredBaseURL) => {
    mocks.client = queryClient({
      data: digestRow({
        rendered_md: feedbackMarkdown("2026-07-12", { baseURL: configuredBaseURL }),
      }),
      error: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(serverChanSuccess());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runSendLastCommand(environment({ WEB_BASE_URL: configuredBaseURL }), activeFeedbackInstant),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refuses to resend a digest at the exact feedback-expiry boundary", async () => {
    mocks.client = queryClient({
      data: digestRow(),
      error: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runSendLastCommand(environment(), new Date("2026-08-02T16:00:00.000Z")),
    ).rejects.toThrow(/feedback links have expired/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("still sends one millisecond before the exact feedback-expiry boundary", async () => {
    mocks.client = queryClient({ data: digestRow(), error: null });
    const fetchMock = vi.fn().mockResolvedValue(serverChanSuccess());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runSendLastCommand(environment(), new Date("2026-08-02T15:59:59.999Z")),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["legacy click-to-write link", "[👍](https://papers.example.com/api/feedback?i=x&r=up&t=old)"],
    ["missing rating link", feedbackMarkdown("2026-07-12", { omitDown: true })],
    ["rotated secret", feedbackMarkdown("2026-07-12", { secret: "o".repeat(40) })],
    ["rotated base URL", feedbackMarkdown("2026-07-12", { baseURL: "https://old.example.com" })],
  ])("refuses to reissue a digest with $name", async (_name, markdown) => {
    mocks.client = queryClient({
      data: digestRow({ rendered_md: markdown }),
      error: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runSendLastCommand(environment(), activeFeedbackInstant),
    ).rejects.toThrow(/stored digest feedback links have expired or are invalid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
