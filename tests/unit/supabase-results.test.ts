import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  fetchFeedback,
  fetchSignals,
  filterRecentlyDelivered,
  saveDigest,
  upsertItems,
} from "../../lib/supabase.ts";
import type { NormalizedItem, SummarizedItem } from "../../lib/types.ts";
import { withRuntimeEnvironment } from "../../lib/runtime-env.ts";
import { sourceIdentityHash } from "../../lib/normalize.ts";

const mocks = vi.hoisted(() => {
  const state = {
    client: undefined as unknown,
    createClient: vi.fn(),
  };
  state.createClient.mockImplementation(() => state.client);
  return state;
});

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

let environmentId = 0;
const ids = {
  one: "00000000-0000-4000-8000-000000000001",
  two: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
};
const databaseId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

beforeEach(() => {
  mocks.createClient.mockClear();
});

function item(externalId: string): NormalizedItem {
  return {
    abstract: "abstract",
    authors: ["author"],
    externalId,
    publishedAt: "2026-07-09T00:00:00.000Z",
    signals: {},
    source: "arxiv",
    title: `Paper ${externalId}`,
    url: `https://example.com/${externalId}`,
  };
}

function summarized(externalId: string, rank: number): SummarizedItem {
  return {
    ...item(externalId),
    impactMd: `impact ${externalId}`,
    oneLiner: `one line ${externalId}`,
    rank,
    rationale: `reason ${externalId}`,
    score: 100 - rank,
    summaryMd: `summary ${externalId}`,
  };
}

function upsertClient(response: unknown) {
  const select = vi.fn().mockResolvedValue(response);
  const builder = { select };
  const upsert = vi.fn().mockReturnValue(builder);
  const from = vi.fn().mockReturnValue({ upsert });
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select,
    upsert,
  };
}

function callUpsert(
  items: NormalizedItem[],
  client: SupabaseClient,
  pipeline?: { runDate: string; runId: string },
) {
  mocks.client = client;
  environmentId += 1;
  return withRuntimeEnvironment(
    {
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${String(environmentId).padStart(40, "s")}`,
      SUPABASE_URL: `https://db-${environmentId}.supabase.co`,
    },
    () => upsertItems(items, pipeline),
  );
}

function resultQuery(response: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {};
  for (const method of [
    "delete",
    "eq",
    "gte",
    "in",
    "insert",
    "limit",
    "not",
    "order",
    "select",
    "single",
    "upsert",
  ] as const) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  return query;
}

function readClient(...responses: unknown[]) {
  const queries = responses.map(resultQuery);
  const from = vi.fn();
  for (const query of queries) from.mockReturnValueOnce(query);
  return { client: { from } as unknown as SupabaseClient, from, queries };
}

function callWithClient<T>(client: SupabaseClient, operation: () => Promise<T>): Promise<T> {
  mocks.client = client;
  environmentId += 1;
  return withRuntimeEnvironment(
    {
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${String(environmentId).padStart(40, "s")}`,
      SUPABASE_URL: `https://db-${environmentId}.supabase.co`,
    },
    operation,
  );
}

function callSaveDigest(
  items: SummarizedItem[],
  idByKey: Map<string, string>,
  markdown: string,
  client: SupabaseClient,
  pipelineRunId?: string,
) {
  return callWithClient(client, () =>
    saveDigest("2026-07-12", items, idByKey, markdown, pipelineRunId),
  );
}

function digestClient(response: unknown) {
  const rpc = vi.fn().mockResolvedValue(response);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("upsertItems result handling", () => {
  test("treats an empty batch as a database-free no-op", async () => {
    const fake = upsertClient({ data: [], error: null });

    await expect(callUpsert([], fake.client)).resolves.toEqual(new Map());
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fake.from).not.toHaveBeenCalled();
  });

  test("returns the exact acknowledged source/external-id mapping", async () => {
    const fake = upsertClient({
      data: [
        { canonical_key: "arxiv:one", id: ids.one },
        { canonical_key: "arxiv:two", id: ids.two },
      ],
      error: null,
    });

    await expect(callUpsert([item("one"), item("two")], fake.client)).resolves.toEqual(
      new Map([
        ["arxiv:one", ids.one],
        ["arxiv:two", ids.two],
      ]),
    );
    expect(fake.upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ canonical_key: "arxiv:one" }),
        expect.objectContaining({ canonical_key: "arxiv:two" }),
      ]),
      { onConflict: "canonical_key" },
    );
  });

  test("binds the item upsert transaction to the active pipeline owner", async () => {
    const runId = "77777777-7777-4777-8777-777777777777";
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        canonical_key: "arxiv:one",
        external_id: "one",
        id: ids.one,
        source: "arxiv",
      }],
      error: null,
    });
    const client = { rpc } as unknown as SupabaseClient;

    await expect(callUpsert([item("one")], client, {
      runDate: "2026-07-15",
      runId,
    })).resolves.toEqual(new Map([["arxiv:one", ids.one]]));
    expect(rpc).toHaveBeenCalledWith("upsert_pipeline_items", {
      p_items: [expect.objectContaining({ canonical_key: "arxiv:one" })],
      p_run_date: "2026-07-15",
      p_run_id: runId,
    });
  });

  test("accepts a database-routed canonical key when the source alias is stable", async () => {
    const drifting = {
      ...item("stable-entry"),
      source: "blog" as const,
      url: "https://doi.org/10.1234/stable-entry",
    };
    const fake = upsertClient({
      data: [{
        canonical_key: "blog:stable-entry",
        external_id: "stable-entry",
        id: ids.one,
        source: "blog",
      }],
      error: null,
    });

    await expect(callUpsert([drifting], fake.client)).resolves.toEqual(
      new Map([["blog:stable-entry", ids.one]]),
    );
  });

  test("rejects duplicate source identities even when metadata derives two canonical keys", async () => {
    const fake = upsertClient({ data: [], error: null });
    const first = { ...item("stable-entry"), source: "blog" as const, url: "https://example.com/entry" };
    const second = { ...first, url: "https://doi.org/10.1234/entry" };

    await expect(callUpsert([first, second], fake.client)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.upsert",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  test("retries one concurrent first-writer alias conflict after the winner commits", async () => {
    const select = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "private detail" } })
      .mockResolvedValueOnce({
        data: [{ canonical_key: "arxiv:one", id: ids.one }],
        error: null,
      });
    const upsert = vi.fn().mockReturnValue({ select });
    const client = { from: vi.fn().mockReturnValue({ upsert }) } as unknown as SupabaseClient;

    await expect(callUpsert([item("one")], client)).resolves.toEqual(
      new Map([["arxiv:one", ids.one]]),
    );
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  test("rejects duplicate canonical identities before creating a database client", async () => {
    const fake = upsertClient({ data: [], error: null });
    const arxiv = item("2406.12345v2");
    const huggingFace = { ...item("2406.12345"), source: "huggingface" as const };

    await expect(callUpsert([arxiv, huggingFace], fake.client)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.upsert",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "missing row",
      rows: [{ canonical_key: "arxiv:one", id: ids.one }],
    },
    {
      name: "unexpected row",
      rows: [
        { canonical_key: "arxiv:one", id: ids.one },
        { canonical_key: "arxiv:two", id: ids.two },
        { canonical_key: "blog:other", id: ids.other },
      ],
    },
    {
      name: "invalid id",
      rows: [
        { canonical_key: "arxiv:one", id: "" },
        { canonical_key: "arxiv:two", id: ids.two },
      ],
    },
    {
      name: "whitespace id",
      rows: [
        { canonical_key: "arxiv:one", id: "   " },
        { canonical_key: "arxiv:two", id: ids.two },
      ],
    },
    {
      name: "non-UUID id",
      rows: [
        { canonical_key: "arxiv:one", id: "not-a-database-uuid" },
        { canonical_key: "arxiv:two", id: ids.two },
      ],
    },
    {
      name: "duplicate returned key",
      rows: [
        { canonical_key: "arxiv:one", id: ids.one },
        { canonical_key: "arxiv:one", id: ids.one },
        { canonical_key: "arxiv:two", id: ids.two },
      ],
    },
    {
      name: "duplicate database id",
      rows: [
        { canonical_key: "arxiv:one", id: ids.one },
        { canonical_key: "arxiv:two", id: ids.one },
      ],
    },
  ])("fails closed on an integrity mismatch: $name", async ({ rows }) => {
    const fake = upsertClient({ data: rows, error: null });

    await expect(callUpsert([item("one"), item("two")], fake.client)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.upsert",
    });
  });

  test("rejects duplicate input keys before creating a database client", async () => {
    const fake = upsertClient({
      data: [{ canonical_key: "arxiv:one", id: ids.one }],
      error: null,
    });

    await expect(callUpsert([item("one"), item("one")], fake.client)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.upsert",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fake.from).not.toHaveBeenCalled();
  });

  test("wraps provider failures without disclosing provider details", async () => {
    const sentinel = "postgres-secret-query-detail";
    const fake = upsertClient({
      data: null,
      error: { code: "PGRST999", message: sentinel },
    });

    const error = await callUpsert([item("one")], fake.client).catch((caught) => caught);
    expect(error).toMatchObject({ code: "DB_OPERATION_FAILED", operation: "items.upsert" });
    expect(String(error)).not.toContain(sentinel);
  });
});

describe("canonical novelty filtering", () => {
  test("suppresses a cross-source identity only after a successful delivery", async () => {
    const fake = digestClient({
      data: [{
        canonical_key: "arxiv:2406.12345",
        identity_hash: sourceIdentityHash("huggingface", "2406.12345v2"),
      }],
      error: null,
    });
    const candidates: NormalizedItem[] = [
      { ...item("2406.12345v2"), source: "huggingface" },
      { ...item("different"), source: "blog", url: "https://example.com/different" },
    ];

    await expect(callWithClient(
      fake.client,
      () => filterRecentlyDelivered(candidates, 14, new Date("2026-07-15T12:00:00.000Z")),
    )).resolves.toEqual([candidates[1]]);
    expect(fake.rpc).toHaveBeenCalledWith("successful_delivery_canonical_keys", {
      p_since: "2026-07-01T12:00:00.000Z",
      p_until: "2026-07-15T12:00:00.000Z",
    });
  });

  test("suppresses a delivered source identity after its public URL changes canonical form", async () => {
    const candidate = {
      ...item("stable-entry"),
      source: "blog" as const,
      url: "https://doi.org/10.1234/stable-entry",
    };
    const fake = digestClient({
      data: [{
        canonical_key: "blog:stable-entry",
        identity_hash: sourceIdentityHash("blog", "stable-entry"),
      }],
      error: null,
    });
    await expect(callWithClient(
      fake.client,
      () => filterRecentlyDelivered([candidate], 14, new Date("2026-07-15T12:00:00.000Z")),
    )).resolves.toEqual([]);
  });
});

describe("signal and feedback query result handling", () => {
  test("distinguishes legitimate empty signal tables from query failures", async () => {
    const empty = readClient(
      { data: [], error: null },
      { data: [], error: null },
    );
    await expect(callWithClient(empty.client, fetchSignals)).resolves.toEqual({
      annotations: [],
      chats: [],
    });

    const sentinel = "private annotations query detail";
    const failed = readClient(
      { data: null, error: { code: "PGRST601", message: sentinel } },
      { data: [], error: null },
    );
    const error = await callWithClient(failed.client, fetchSignals).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "annotations.fetchSignals",
    });
    expect(String(error)).not.toContain(sentinel);
    expect(failed.from).toHaveBeenCalledTimes(1);
  });

  test("checks chat failures and rejects null data without an error", async () => {
    const chatFailure = readClient(
      { data: [], error: null },
      { data: null, error: { code: "PGRST602", message: "private chat detail" } },
    );
    await expect(callWithClient(chatFailure.client, fetchSignals)).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "chats.fetchSignals",
    });

    const nullAnnotations = readClient(
      { data: null, error: null },
      { data: [], error: null },
    );
    await expect(callWithClient(nullAnnotations.client, fetchSignals)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchSignals",
    });
  });

  test("maps valid signal rows from object and array relations", async () => {
    const fake = readClient(
      {
        data: [
          { body: "note body", items: { title: "Object title" }, type: "note" },
          { body: "quote", items: [{ title: "Array title" }], type: "highlight" },
        ],
        error: null,
      },
      {
        data: [{ content: "question", items: { title: "Chat title" } }],
        error: null,
      },
    );

    await expect(callWithClient(fake.client, fetchSignals)).resolves.toEqual({
      annotations: [
        { body: "note body", title: "Object title", type: "note" },
        { body: "quote", title: "Array title", type: "highlight" },
      ],
      chats: [{ content: "question", title: "Chat title" }],
    });
  });

  test.each([
    { items: null, name: "null relation" },
    { items: [{ title: "one" }, { title: "two" }], name: "multi-row relation" },
  ])("rejects a malformed signal $name", async ({ items }) => {
    const malformed = readClient(
      { data: [{ body: "valid body", items, type: "note" }], error: null },
      { data: [], error: null },
    );
    await expect(callWithClient(malformed.client, fetchSignals)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchSignals",
    });
  });

  test("distinguishes empty feedback from a failed or null query", async () => {
    const empty = readClient({ data: [], error: null });
    await expect(callWithClient(empty.client, fetchFeedback)).resolves.toEqual([]);

    const failure = readClient({
      data: null,
      error: { code: "PGRST603", message: "private feedback detail" },
    });
    await expect(callWithClient(failure.client, fetchFeedback)).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "feedback.fetchRecent",
    });

    const nullData = readClient({ data: null, error: null });
    await expect(callWithClient(nullData.client, fetchFeedback)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.fetchRecent",
    });
  });

  test("maps a valid feedback relation without changing its public shape", async () => {
    const fake = readClient({
      data: [
        {
          items: { signals: { category: "cs.AI" }, source: "arxiv", title: "Paper" },
          note: "useful",
          rating: "up",
        },
      ],
      error: null,
    });

    await expect(callWithClient(fake.client, () => fetchFeedback(7))).resolves.toEqual([
      {
        category: "cs.AI",
        note: "useful",
        rating: "up",
        source: "arxiv",
        title: "Paper",
      },
    ]);

    const arrayRelation = readClient({
      data: [
        {
          items: [{ signals: {}, source: "blog", title: "Array paper" }],
          note: null,
          rating: "down",
        },
      ],
      error: null,
    });
    await expect(callWithClient(arrayRelation.client, fetchFeedback)).resolves.toEqual([
      {
        category: "",
        note: null,
        rating: "down",
        source: "blog",
        title: "Array paper",
      },
    ]);
  });

  test.each([
    { items: null, name: "null relation" },
    {
      items: [
        { signals: {}, source: "arxiv", title: "one" },
        { signals: {}, source: "blog", title: "two" },
      ],
      name: "multi-row relation",
    },
  ])("rejects a malformed feedback $name", async ({ items }) => {
    const malformed = readClient({
      data: [{ items, note: null, rating: "up" }],
      error: null,
    });
    await expect(callWithClient(malformed.client, fetchFeedback)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.fetchRecent",
    });
  });
});

describe("saveDigest result handling", () => {
  const top = [summarized("one", 1), summarized("two", 2)];
  const mapping = new Map([
    ["arxiv:one", ids.one],
    ["arxiv:two", ids.two],
  ]);
  const markdown = "# deterministic digest";

  test.each([
    { name: "empty", top: [] as SummarizedItem[] },
    {
      name: "more than five items",
      top: Array.from({ length: 6 }, (_, index) => summarized(String(index + 1), index + 1)),
    },
  ])("rejects an $name digest before opening a database client", async ({ top }) => {
    const mapped = new Map(
      top.map((entry, index) => [
        `${entry.source}:${entry.externalId}`,
        databaseId(index + 10),
      ]),
    );
    const fake = digestClient({ data: [], error: null });

    await expect(
      callSaveDigest(top, mapped, markdown, fake.client),
    ).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED", operation: "digests.save" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  test("rejects incomplete or duplicate mappings before opening a database client", async () => {
    const fake = digestClient({ data: null, error: null });

    await expect(
      callSaveDigest(top, new Map([["arxiv:one", ids.one]]), markdown, fake.client),
    ).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED", operation: "digests.save" });
    expect(mocks.createClient).not.toHaveBeenCalled();

    await expect(
      callSaveDigest(
        top,
        new Map([
          ["arxiv:one", ids.one],
          ["arxiv:two", ids.one],
        ]),
        markdown,
        fake.client,
      ),
    ).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED", operation: "digests.save" });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  test.each([
    { name: "non-finite score", mutate: { score: Number.NaN } },
    { name: "fractional score", mutate: { score: 98.5 } },
    { name: "semantic score overflow", mutate: { score: 101 } },
    { name: "out-of-range score", mutate: { score: 2_147_483_648 } },
    { name: "out-of-order rank", mutate: { rank: 2 } },
  ])("rejects a $name before opening a database client", async ({ mutate }) => {
    const fake = digestClient({ data: [], error: null });
    const invalid = [{ ...top[0], ...mutate }, top[1]];

    await expect(
      callSaveDigest(invalid, mapping, markdown, fake.client),
    ).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED", operation: "digests.save" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  test.each(["inserted", "existing"])(
    "accepts an exact immutable %s snapshot acknowledgement",
    async (outcome) => {
      const fake = digestClient({
        data: [{
          outcome,
          persisted_digest_date: "2026-07-12",
          persisted_rendered_md: markdown,
          persisted_summary_count: 2,
          persisted_top5_item_ids: [ids.one, ids.two],
        }],
        error: null,
      });

      await expect(callSaveDigest(top, mapping, markdown, fake.client)).resolves.toBeUndefined();
      expect(fake.rpc).toHaveBeenCalledWith("store_digest_bundle", {
        p_digest_date: "2026-07-12",
        p_impact_mds: ["impact one", "impact two"],
        p_item_ids: [ids.one, ids.two],
        p_one_liners: ["one line one", "one line two"],
        p_ranks: [1, 2],
        p_rendered_md: markdown,
        p_scores: [99, 98],
        p_summary_mds: ["summary one", "summary two"],
      });
    },
  );

  test("binds digest persistence to the active pipeline owner", async () => {
    const runId = "00000000-0000-4000-8000-000000000009";
    const fake = digestClient({
      data: [{
        outcome: "inserted",
        persisted_digest_date: "2026-07-12",
        persisted_rendered_md: markdown,
        persisted_summary_count: 2,
        persisted_top5_item_ids: [ids.one, ids.two],
      }],
      error: null,
    });

    await expect(callSaveDigest(top, mapping, markdown, fake.client, runId)).resolves.toBeUndefined();
    expect(fake.rpc).toHaveBeenCalledWith("store_pipeline_digest_bundle", expect.objectContaining({
      p_digest_date: "2026-07-12",
      p_run_id: runId,
    }));
  });

  test.each([
    { rows: null, name: "null acknowledgement" },
    { rows: [], name: "missing acknowledgement" },
    {
      rows: [
        { outcome: "existing" },
        { outcome: "existing" },
      ],
      name: "multiple acknowledgements",
    },
    {
      rows: [{
        outcome: "existing",
        persisted_digest_date: "2026-07-11",
        persisted_rendered_md: markdown,
        persisted_top5_item_ids: [ids.one, ids.two],
      }],
      name: "wrong date",
    },
    {
      rows: [{
        outcome: "existing",
        persisted_digest_date: "2026-07-12",
        persisted_rendered_md: markdown,
        persisted_top5_item_ids: [ids.two, ids.one],
      }],
      name: "wrong item order",
    },
    {
      rows: [{
        outcome: "existing",
        persisted_digest_date: "2026-07-12",
        persisted_rendered_md: "different markdown",
        persisted_top5_item_ids: [ids.one, ids.two],
      }],
      name: "wrong markdown",
    },
    {
      rows: [{
        outcome: "conflict",
        persisted_digest_date: "2026-07-12",
        persisted_rendered_md: "first-run snapshot",
        persisted_top5_item_ids: [ids.one, ids.other],
      }],
      name: "same-day rerun conflict",
    },
  ])("fails closed on $name", async ({ rows }) => {
    const fake = digestClient({ data: rows, error: null });

    await expect(
      callSaveDigest(top, mapping, markdown, fake.client),
    ).rejects.toMatchObject({ code: "DB_INTEGRITY_FAILED", operation: "digests.save" });
  });

  test("wraps an immutable snapshot RPC error without its details", async () => {
    const sentinel = "private digest snapshot detail";
    const fake = digestClient({
      data: null,
      error: { code: "PGRST701", message: sentinel },
    });

    const error = await callSaveDigest(
      top,
      mapping,
      markdown,
      fake.client,
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "digests.save",
    });
    expect(String(error)).not.toContain(sentinel);
  });
});
