import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("server-only", () => ({}));

import {
  addAnnotation as addAnnotationWithOwner,
  getAnnotations as getAnnotationsWithOwner,
  getChats as getChatsWithOwner,
  getPaper as getPaperWithOwner,
  getTop5 as getTop5WithOwner,
  listArchive as listArchiveWithOwner,
} from "@/lib/data";
import type { OwnerContext } from "@/lib/auth";

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
} as OwnerContext;
const getTop5 = () => getTop5WithOwner(owner);
const getPaper = (id: string) => getPaperWithOwner(owner, id);
const listArchive = (limit?: number) =>
  limit === undefined ? listArchiveWithOwner(owner) : listArchiveWithOwner(owner, limit);
const getChats = (itemId: string) => getChatsWithOwner(owner, itemId);
const getAnnotations = (itemId: string) => getAnnotationsWithOwner(owner, itemId);
const addAnnotation = (
  itemId: string,
  type: Parameters<typeof addAnnotationWithOwner>[2],
  anchor: unknown,
  color: string,
  body: string | null,
) => addAnnotationWithOwner(owner, itemId, type, anchor, color, body);

const ids = {
  lettered: "abcdef12-3456-4789-8abc-def012345678",
  one: "00000000-0000-4000-8000-000000000001",
  two: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
};
const databaseId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function item(id: string, title: string) {
  return {
    abstract: `${title} abstract`,
    authors: ["Author"],
    external_id: title.toLowerCase(),
    id,
    published_at: "2026-07-12T00:00:00.000Z",
    signals: {},
    source: "arxiv",
    title,
    url: `https://example.com/${id}`,
  };
}

function summary(itemId: string, rank: number) {
  return {
    impact_md: `impact ${rank}`,
    item_id: itemId,
    one_liner: `one line ${rank}`,
    rank,
    score: 100 - rank,
    summary_md: `summary ${rank}`,
  };
}

function resultQuery(response: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {};
  for (const method of ["eq", "in", "limit", "maybeSingle", "order", "range", "select"] as const) {
    query[method] = vi.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  return query;
}

function database(responses: Record<string, unknown[]>) {
  const queries = new Map(
    Object.entries(responses).map(([table, values]) => [table, values.map(resultQuery)]),
  );
  const queues = new Map([...queries].map(([table, values]) => [table, [...values]]));
  mocks.from.mockImplementation((table: string) => {
    const query = queues.get(table)?.shift();
    if (!query) throw new Error(`Unexpected table query: ${table}`);
    return query;
  });
  return { queries };
}

function validTop5Bundle() {
  return {
    digest_date: "2026-07-12",
    papers: [
      { ...item(ids.two, "Two"), ...summary(ids.two, 1), rating: null },
      { ...item(ids.one, "One"), ...summary(ids.one, 2), rating: "up" },
    ],
    top5_item_ids: [ids.two, ids.one],
  };
}

function rpcResult(data: unknown, error: unknown = null) {
  mocks.rpc.mockResolvedValue({ data, error });
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
});

describe("getTop5 database result handling", () => {
  test("reads the digest, items, summaries, and ratings through one atomic RPC", async () => {
    rpcResult([validTop5Bundle()]);

    await expect(getTop5()).resolves.toMatchObject({
      date: "2026-07-12",
      papers: [{ id: ids.two }, { id: ids.one, rating: "up" }],
    });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("get_latest_digest_bundle");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("returns an empty state only for a genuine no-digest result", async () => {
    rpcResult([]);

    await expect(getTop5()).resolves.toEqual({ date: null, papers: [] });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  test("surfaces an RPC failure without provider details", async () => {
    const sentinel = "private bundle query detail";
    rpcResult(null, { code: "PGRST901", message: sentinel });

    const error = await getTop5().catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "digests.fetchTop5",
    });
    expect(String(error)).not.toContain(sentinel);
  });

  test.each([
    {
      data: null,
      name: "a null result",
    },
    {
      data: [validTop5Bundle(), validTop5Bundle()],
      name: "multiple envelopes",
    },
    {
      data: [{ ...validTop5Bundle(), papers: "not-an-array" }],
      name: "a non-array papers field",
    },
    {
      data: [{ ...validTop5Bundle(), papers: [], top5_item_ids: [] }],
      name: "an empty digest",
    },
  ])("rejects $name instead of manufacturing an empty state", async ({ data }) => {
    rpcResult(data);
    await expect(getTop5()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchTop5",
    });
  });

  test.each([
    {
      name: "more than five ids",
      top5_item_ids: Array.from({ length: 6 }, (_, index) => databaseId(index + 10)),
    },
    {
      name: "duplicate ids",
      top5_item_ids: [ids.one, ids.one],
    },
    {
      name: "invalid id",
      top5_item_ids: ["not-a-uuid"],
    },
    {
      digest_date: "2026-02-29" as string,
      name: "invalid Gregorian date",
    },
  ])("rejects a digest with $name", async (malformed) => {
    rpcResult([{ ...validTop5Bundle(), ...malformed }]);
    await expect(getTop5()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchTop5",
    });
  });

  test.each([
    {
      name: "a missing paper",
      papers: [validTop5Bundle().papers[0]],
    },
    {
      name: "a duplicate paper",
      papers: [
        validTop5Bundle().papers[0],
        validTop5Bundle().papers[0],
      ],
    },
    {
      name: "a paper outside the digest",
      papers: [
        validTop5Bundle().papers[0],
        { ...item(ids.other, "Other"), ...summary(ids.other, 2), rating: null },
      ],
    },
  ])("rejects $name", async ({ papers }) => {
    rpcResult([{ ...validTop5Bundle(), papers }]);
    await expect(getTop5()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchTop5",
    });
  });

  test.each([
    {
      name: "rank order conflicts with digest order",
      papers: [
        { ...validTop5Bundle().papers[0], rank: 2 },
        { ...validTop5Bundle().papers[1], rank: 1 },
      ],
    },
    {
      name: "an item field is missing",
      papers: [
        { ...validTop5Bundle().papers[0], title: null },
        validTop5Bundle().papers[1],
      ],
    },
    {
      name: "a summary field is missing",
      papers: [
        { ...validTop5Bundle().papers[0], one_liner: null },
        validTop5Bundle().papers[1],
      ],
    },
    {
      name: "a summary item id differs from its item",
      papers: [
        { ...validTop5Bundle().papers[0], item_id: ids.one },
        validTop5Bundle().papers[1],
      ],
    },
    {
      name: "a rating is invalid",
      papers: [
        { ...validTop5Bundle().papers[0], rating: "maybe" },
        validTop5Bundle().papers[1],
      ],
    },
  ])("rejects when $name", async ({ papers }) => {
    rpcResult([{ ...validTop5Bundle(), papers }]);
    await expect(getTop5()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchTop5",
    });
  });

  test.each([
    { name: "a fractional score", score: 99.5 },
    { name: "a non-finite score", score: Number.NaN },
    { name: "a negative score", score: -1 },
    { name: "a score above one hundred", score: 101 },
  ])("rejects $name", async ({ score }) => {
    rpcResult([
      {
        ...validTop5Bundle(),
        papers: [
          { ...validTop5Bundle().papers[0], score },
          validTop5Bundle().papers[1],
        ],
      },
    ]);
    await expect(getTop5()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "digests.fetchTop5",
    });
  });
});

describe("getPaper database result handling", () => {
  test("returns null only when the item query genuinely has no row", async () => {
    database({ items: [{ data: null, error: null }] });
    await expect(getPaper(ids.one)).resolves.toBeNull();
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  test("surfaces item failure and rejects a mismatched response id", async () => {
    database({
      items: [{ data: null, error: { code: "PGRST911", message: "private paper detail" } }],
    });
    await expect(getPaper(ids.one)).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "items.fetchOne",
    });

    database({ items: [{ data: item(ids.two, "Two"), error: null }] });
    await expect(getPaper(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.fetchOne",
    });
  });

  test("propagates summary and rating query failures", async () => {
    database({
      items: [{ data: item(ids.one, "One"), error: null }],
      summaries: [
        { data: null, error: { code: "PGRST912", message: "private paper summary" } },
      ],
    });
    await expect(getPaper(ids.one)).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "summaries.fetchLatest",
    });

    database({
      feedback: [
        { data: null, error: { code: "PGRST913", message: "private paper rating" } },
      ],
      items: [{ data: item(ids.one, "One"), error: null }],
      summaries: [{ data: null, error: null }],
    });
    await expect(getPaper(ids.one)).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "feedback.attach",
    });
  });

  test("returns a valid paper even when summary and rating are genuinely absent", async () => {
    database({
      feedback: [{ data: [], error: null }],
      items: [{ data: item(ids.one, "One"), error: null }],
      summaries: [{ data: null, error: null }],
    });
    await expect(getPaper(ids.one)).resolves.toMatchObject({
      id: ids.one,
      rating: null,
      title: "One",
    });
  });

  test("normalizes an uppercase requested UUID before querying and matching", async () => {
    const fake = database({
      feedback: [{ data: [], error: null }],
      items: [{ data: item(ids.lettered, "Lettered"), error: null }],
      summaries: [{ data: null, error: null }],
    });
    await expect(getPaper(ids.lettered.toUpperCase())).resolves.toMatchObject({
      id: ids.lettered,
      title: "Lettered",
    });
    expect(fake.queries.get("items")?.[0].eq).toHaveBeenCalledWith("id", ids.lettered);
  });

  test("queries and returns the deterministic latest historical summary", async () => {
    const latest = {
      ...summary(ids.one, 7),
      created_at: "2026-07-12T03:00:00.000Z",
      id: databaseId(700),
    };
    const fake = database({
      feedback: [{ data: [], error: null }],
      items: [{ data: item(ids.one, "One"), error: null }],
      summaries: [{ data: latest, error: null }],
    });

    await expect(getPaper(ids.one)).resolves.toMatchObject({ summary: { rank: 7 } });
    const query = fake.queries.get("summaries")?.[0];
    expect(query?.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(query?.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(query?.limit).toHaveBeenCalledWith(1);
    expect(query?.maybeSingle).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "a different item reference",
      row: {
        ...summary(ids.two, 7),
        created_at: "2026-07-12T03:00:00.000Z",
        id: databaseId(701),
      },
    },
    {
      name: "an invalid timestamp",
      row: {
        ...summary(ids.one, 7),
        created_at: "2026-02-29T03:00:00.000Z",
        id: databaseId(702),
      },
    },
  ])("rejects latest summary row with $name", async ({ row }) => {
    database({
      items: [{ data: item(ids.one, "One"), error: null }],
      summaries: [{ data: row, error: null }],
    });

    await expect(getPaper(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "summaries.fetchLatest",
    });
  });
});

describe("listArchive database result handling", () => {
  const archivedSummary = (itemId: string, rank: number, createdAt: string) => ({
    ...summary(itemId, rank),
    created_at: createdAt,
    id: databaseId(100 + rank),
  });

  test("returns empty only for a genuine empty summary result", async () => {
    database({ summaries: [{ data: [], error: null }] });
    await expect(listArchive()).resolves.toEqual([]);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  test("surfaces summary query failure and null data", async () => {
    database({
      summaries: [
        { data: null, error: { code: "PGRST914", message: "private archive summary" } },
      ],
    });
    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "summaries.listArchive",
    });

    database({ summaries: [{ data: null, error: null }] });
    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "summaries.listArchive",
    });
  });

  test("rejects item query failure and a missing referenced item", async () => {
    const sums = [archivedSummary(ids.one, 1, "2026-07-12T01:00:00.000Z")];
    database({
      items: [{ data: null, error: { code: "PGRST915", message: "private archive item" } }],
      summaries: [{ data: sums, error: null }],
    });
    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "items.listArchive",
    });

    database({
      items: [{ data: [], error: null }],
      summaries: [{ data: sums, error: null }],
    });
    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "items.listArchive",
    });
  });

  test("keeps the newest summary per item in archive order", async () => {
    const fake = database({
      items: [{ data: [item(ids.two, "Two"), item(ids.one, "One")], error: null }],
      summaries: [
        {
          data: [
            archivedSummary(ids.one, 9, "2026-07-12T03:00:00.000Z"),
            archivedSummary(ids.two, 8, "2026-07-12T02:00:00.000Z"),
            archivedSummary(ids.one, 1, "2026-07-11T01:00:00.000Z"),
          ],
          error: null,
        },
      ],
    });

    const result = await listArchive();
    expect(result.map((paper) => paper.id)).toEqual([ids.one, ids.two]);
    expect(result.map((paper) => paper.summary?.rank)).toEqual([9, 8]);
    const query = fake.queries.get("summaries")?.[0];
    expect(query?.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(query?.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(query?.range).toHaveBeenCalledWith(0, 119);
  });

  test.each([
    "2026-02-29T03:00:00.000Z",
    "2026-07-12 03:00:00+00",
  ])("rejects noncanonical archive timestamp %s", async (createdAt) => {
    database({
      summaries: [{ data: [archivedSummary(ids.one, 1, createdAt)], error: null }],
    });
    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "summaries.listArchive",
    });
  });

  test("rejects a duplicate summary id", async () => {
    const duplicateId = databaseId(900);
    database({
      summaries: [
        {
          data: [
            {
              ...archivedSummary(ids.one, 2, "2026-07-12T03:00:00.000Z"),
              id: duplicateId,
            },
            {
              ...archivedSummary(ids.two, 1, "2026-07-12T02:00:00.000Z"),
              id: duplicateId,
            },
          ],
          error: null,
        },
      ],
    });

    await expect(listArchive()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "summaries.listArchive",
    });
  });

  test("applies the archive limit after deduplicating historical summaries", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...summary(ids.one, index + 1),
      created_at: new Date(Date.parse("2026-07-12T03:00:00.000Z") - index * 1_000).toISOString(),
      id: databaseId(1000 + index),
    }));
    const secondPage = [
      {
        ...summary(ids.two, 1),
        created_at: "2026-07-11T01:00:00.000Z",
        id: databaseId(2000),
      },
    ];
    database({
      items: [{ data: [item(ids.one, "One"), item(ids.two, "Two")], error: null }],
      summaries: [
        { data: firstPage, error: null },
        { data: secondPage, error: null },
      ],
    });

    const result = await listArchive(2);
    expect(result.map((paper) => paper.id)).toEqual([ids.one, ids.two]);
  });
});

describe("getChats database result handling", () => {
  const chat = (
    id: string,
    itemId: string,
    role: "user" | "assistant",
    content: string,
    createdAt: string,
  ) => ({ id, item_id: itemId, role, content, created_at: createdAt });

  test("rejects a malformed requested item id before querying", async () => {
    await expect(getChats("not-a-uuid")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("distinguishes a genuine empty history from failed or null data", async () => {
    database({ chats: [{ data: [], error: null }] });
    await expect(getChats(ids.one)).resolves.toEqual([]);

    const sentinel = "private chat history detail";
    database({
      chats: [{ data: null, error: { code: "PGRST920", message: sentinel } }],
    });
    const error = await getChats(ids.one).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "chats.fetchHistory",
    });
    expect(String(error)).not.toContain(sentinel);

    database({ chats: [{ data: null, error: null }] });
    await expect(getChats(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
  });

  test("normalizes an uppercase requested item UUID", async () => {
    const fake = database({
      chats: [
        {
          data: [
            chat(
              databaseId(300),
              ids.lettered,
              "user",
              "hello",
              "2026-07-12T01:00:00.000Z",
            ),
          ],
          error: null,
        },
      ],
    });
    await expect(getChats(ids.lettered.toUpperCase())).resolves.toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(fake.queries.get("chats")?.[0].eq).toHaveBeenCalledWith("item_id", ids.lettered);
  });

  test.each([
    {
      name: "a malformed id",
      row: chat("not-a-uuid", ids.one, "user", "hello", "2026-07-12T01:00:00.000Z"),
    },
    {
      name: "a mismatched item",
      row: chat(databaseId(301), ids.two, "user", "hello", "2026-07-12T01:00:00.000Z"),
    },
    {
      name: "an invalid role",
      row: {
        ...chat(databaseId(302), ids.one, "user", "hello", "2026-07-12T01:00:00.000Z"),
        role: "system",
      },
    },
    {
      name: "non-string content",
      row: {
        ...chat(databaseId(303), ids.one, "user", "hello", "2026-07-12T01:00:00.000Z"),
        content: 7,
      },
    },
    {
      name: "an invalid timestamp",
      row: chat(databaseId(304), ids.one, "user", "hello", "2026-02-29T01:00:00.000Z"),
    },
  ])("rejects a chat row with $name", async ({ row }) => {
    database({ chats: [{ data: [row], error: null }] });
    await expect(getChats(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
  });

  test("rejects duplicate chat ids", async () => {
    const duplicateId = databaseId(305);
    database({
      chats: [
        {
          data: [
            chat(duplicateId, ids.one, "assistant", "new", "2026-07-12T02:00:00.000Z"),
            chat(duplicateId, ids.one, "user", "old", "2026-07-12T01:00:00.000Z"),
          ],
          error: null,
        },
      ],
    });
    await expect(getChats(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
  });

  test("rejects chat rows returned outside the requested stable descending order", async () => {
    database({
      chats: [
        {
          data: [
            chat(databaseId(306), ids.one, "user", "old", "2026-07-12T01:00:00.000Z"),
            chat(databaseId(307), ids.one, "assistant", "new", "2026-07-12T02:00:00.000Z"),
          ],
          error: null,
        },
      ],
    });
    await expect(getChats(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
  });

  test("rejects more rows than the requested chat limit", async () => {
    const newest = Date.parse("2026-07-12T02:00:00.000Z");
    const rows = Array.from({ length: 61 }, (_, index) =>
      chat(
        databaseId(500 + index),
        ids.one,
        index % 2 === 0 ? "assistant" : "user",
        `message ${index}`,
        new Date(newest - index * 1_000).toISOString(),
      ),
    );
    database({ chats: [{ data: rows, error: null }] });
    await expect(getChats(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.fetchHistory",
    });
  });

  test("orders microseconds, equivalent offsets, and timestamp ties deterministically", async () => {
    database({
      chats: [
        {
          data: [
            chat(databaseId(610), ids.one, "assistant", "micro-new", "2026-07-12T02:00:00.000999Z"),
            chat(databaseId(609), ids.one, "user", "micro-old", "2026-07-12T02:00:00.000001Z"),
            chat(databaseId(608), ids.one, "assistant", "tie-high", "2026-07-12T10:00:00+08:00"),
            chat(databaseId(607), ids.one, "user", "tie-low", "2026-07-12T02:00:00Z"),
          ],
          error: null,
        },
      ],
    });

    await expect(getChats(ids.one)).resolves.toEqual([
      { role: "user", content: "tie-low" },
      { role: "assistant", content: "tie-high" },
      { role: "user", content: "micro-old" },
      { role: "assistant", content: "micro-new" },
    ]);
  });

  test("fetches the newest 60 deterministically and returns chronological DTOs", async () => {
    const fake = database({
      chats: [
        {
          data: [
            chat(databaseId(307), ids.one, "assistant", "new", "2026-07-12T02:00:00.000Z"),
            chat(databaseId(306), ids.one, "user", "old", "2026-07-12T01:00:00.000Z"),
          ],
          error: null,
        },
      ],
    });

    await expect(getChats(ids.one)).resolves.toEqual([
      { role: "user", content: "old" },
      { role: "assistant", content: "new" },
    ]);
    const query = fake.queries.get("chats")?.[0];
    expect(query?.select).toHaveBeenCalledWith("id, item_id, role, content, created_at");
    expect(query?.eq).toHaveBeenCalledWith("item_id", ids.one);
    expect(query?.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(query?.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(query?.limit).toHaveBeenCalledWith(60);
  });
});

describe("getAnnotations database result handling", () => {
  const annotation = (
    id: string,
    itemId: string,
    type: "highlight" | "note" | "pen" | "box",
    anchor: unknown,
    createdAt: string,
  ) => ({
    id,
    item_id: itemId,
    type,
    anchor,
    color: "#e0c060",
    body: null,
    created_at: createdAt,
  });

  test("rejects a malformed requested item id before querying", async () => {
    await expect(getAnnotations("not-a-uuid")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchForItem",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("distinguishes a genuine empty annotation list from failed or null data", async () => {
    database({ annotations: [{ data: [], error: null }] });
    await expect(getAnnotations(ids.one)).resolves.toEqual([]);

    const sentinel = "private annotation detail";
    database({
      annotations: [{ data: null, error: { code: "PGRST921", message: sentinel } }],
    });
    const error = await getAnnotations(ids.one).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "annotations.fetchForItem",
    });
    expect(String(error)).not.toContain(sentinel);

    database({ annotations: [{ data: null, error: null }] });
    await expect(getAnnotations(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchForItem",
    });
  });

  test("normalizes an uppercase requested item UUID", async () => {
    const fake = database({
      annotations: [
        {
          data: [
            annotation(
              databaseId(400),
              ids.lettered,
              "note",
              { x: 1, y: 2 },
              "2026-07-12T01:00:00Z",
            ),
          ],
          error: null,
        },
      ],
    });
    await expect(getAnnotations(ids.lettered.toUpperCase())).resolves.toHaveLength(1);
    expect(fake.queries.get("annotations")?.[0].eq).toHaveBeenCalledWith(
      "item_id",
      ids.lettered,
    );
  });

  test.each([
    {
      name: "a malformed id",
      row: annotation("not-a-uuid", ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
    },
    {
      name: "a mismatched item",
      row: annotation(databaseId(401), ids.two, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
    },
    {
      name: "an invalid type",
      row: {
        ...annotation(databaseId(402), ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
        type: "circle",
      },
    },
    {
      name: "an unsafe color",
      row: {
        ...annotation(databaseId(403), ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
        color: "url(javascript:alert(1))",
      },
    },
    {
      name: "a non-string body",
      row: {
        ...annotation(databaseId(404), ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
        body: 4,
      },
    },
    {
      name: "an invalid timestamp",
      row: annotation(databaseId(405), ids.one, "note", { x: 1, y: 2 }, "2026-02-29T01:00:00Z"),
    },
    {
      name: "a renderer-breaking anchor",
      row: annotation(
        databaseId(406),
        ids.one,
        "pen",
        { points: "not-points" },
        "2026-07-12T01:00:00Z",
      ),
    },
    {
      name: "an empty highlight",
      row: annotation(databaseId(412), ids.one, "highlight", { rects: [] }, "2026-07-12T01:00:00Z"),
    },
    {
      name: "a one-point pen stroke",
      row: annotation(databaseId(413), ids.one, "pen", { points: [[1, 2]] }, "2026-07-12T01:00:00Z"),
    },
    {
      name: "a negative box dimension",
      row: annotation(databaseId(414), ids.one, "box", { x: 1, y: 2, w: -3, h: 4 }, "2026-07-12T01:00:00Z"),
    },
    {
      name: "a note without both coordinates",
      row: annotation(databaseId(415), ids.one, "note", { x: 1 }, "2026-07-12T01:00:00Z"),
    },
  ])("rejects an annotation row with $name", async ({ row }) => {
    database({ annotations: [{ data: [row], error: null }] });
    await expect(getAnnotations(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchForItem",
    });
  });

  test("rejects duplicate annotation ids", async () => {
    const duplicateId = databaseId(407);
    database({
      annotations: [
        {
          data: [
            annotation(duplicateId, ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
            annotation(duplicateId, ids.one, "box", { x: 1, y: 2, w: 3, h: 4 }, "2026-07-12T02:00:00Z"),
          ],
          error: null,
        },
      ],
    });
    await expect(getAnnotations(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchForItem",
    });
  });

  test("rejects annotations returned outside the requested stable ascending order", async () => {
    database({
      annotations: [
        {
          data: [
            annotation(databaseId(409), ids.one, "note", { x: 5, y: 6 }, "2026-07-12T02:00:00Z"),
            annotation(databaseId(408), ids.one, "note", { x: 1, y: 2 }, "2026-07-12T01:00:00Z"),
          ],
          error: null,
        },
      ],
    });
    await expect(getAnnotations(ids.one)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.fetchForItem",
    });
  });

  test("returns validated annotations in a deterministic query order", async () => {
    const rows = [
      annotation(databaseId(408), ids.one, "highlight", { rects: [{ x: 1, y: 2, w: 3, h: 4 }] }, "2026-07-12T01:00:00Z"),
      {
        ...annotation(databaseId(409), ids.one, "note", { x: 5, y: 6 }, "2026-07-12T02:00:00Z"),
        body: "note body",
        color: "#A0B1C2",
      },
      annotation(databaseId(410), ids.one, "pen", { points: [[1, 2], [3, 4]] }, "2026-07-12T03:00:00Z"),
      annotation(databaseId(411), ids.one, "box", { x: 7, y: 8, w: 9, h: 10 }, "2026-07-12T04:00:00Z"),
    ];
    const fake = database({
      annotations: [
        {
          data: rows,
          error: null,
        },
      ],
    });

    const result = await getAnnotations(ids.one);
    expect(result).toEqual(
      rows.map(({ anchor, body, color, id, type }) => ({ anchor, body, color, id, type })),
    );
    const query = fake.queries.get("annotations")?.[0];
    expect(query?.select).toHaveBeenCalledWith(
      "id, item_id, type, anchor, color, body, created_at",
    );
    expect(query?.eq).toHaveBeenCalledWith("item_id", ids.one);
    expect(query?.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: true });
    expect(query?.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
  });
});

describe("annotation read/write shape contract", () => {
  test("rejects a renderer-breaking anchor before it can be persisted", async () => {
    await expect(
      addAnnotation(ids.one, "pen", { points: "not-points" }, "#e0c060", null),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.insert",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
