import { beforeEach, describe, expect, test, vi } from "vitest";
import fixture from "../../../tests/fixtures/feedback-token-v1.json";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("server-only", () => ({}));

import {
  addAnnotation as addAnnotationWithOwner,
  deleteAnnotation as deleteAnnotationWithOwner,
  redeemFeedbackToken as redeemFeedbackTokenWithOwner,
  saveChat as saveChatWithOwner,
  saveFeedback as saveFeedbackWithOwner,
} from "@/lib/data";
import type { OwnerContext } from "@/lib/auth";
import { verifyFeedbackToken as verifyRawFeedbackToken } from "@/lib/feedback-token";

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
} as OwnerContext;
const saveFeedback = (
  itemId: string,
  rating: "up" | "down",
  note?: string | null,
  occurredAt?: Date,
) => saveFeedbackWithOwner(owner, itemId, rating, note, occurredAt);
const saveChat = (itemId: string, role: "user" | "assistant", content: string) =>
  saveChatWithOwner(owner, itemId, role, content);
const addAnnotation = (
  itemId: string,
  type: Parameters<typeof addAnnotationWithOwner>[2],
  anchor: unknown,
  color: string,
  body: string | null,
) => addAnnotationWithOwner(owner, itemId, type, anchor, color, body);
const deleteAnnotation = (id: string) => deleteAnnotationWithOwner(owner, id);

const itemId = "00000000-0000-4000-8000-000000000001";
const otherItemId = "00000000-0000-4000-8000-000000000002";
const letteredItemId = "abcdef12-3456-4789-8abc-def012345678";
const uppercaseItemId = letteredItemId.toUpperCase();
const feedbackId = "00000000-0000-4000-8000-000000000301";
const annotationId = "00000000-0000-4000-8000-000000000101";
const letteredAnnotationId = "abcdef12-3456-4789-8abc-def012345679";
const uppercaseAnnotationId = letteredAnnotationId.toUpperCase();
const chatId = "00000000-0000-4000-8000-000000000201";
const createdAt = "2026-07-12T01:00:00.123456Z";
const feedbackClaims = verifyRawFeedbackToken(fixture.secret, fixture.up, 0);
if (!feedbackClaims) throw new Error("Frozen feedback-token fixture must verify");
const redeemFeedbackToken = (claims: typeof feedbackClaims = feedbackClaims) =>
  redeemFeedbackTokenWithOwner(owner, claims);

function resultQuery(response: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {};
  for (const method of [
    "delete",
    "eq",
    "insert",
    "select",
    "single",
    "upsert",
  ] as const) {
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

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
});

describe("redeemFeedbackToken acknowledgement", () => {
  test("rejects a structural clone that was not produced by the verifier", async () => {
    await expect(redeemFeedbackToken({ ...feedbackClaims })).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.redeem",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test.each([
    { ...feedbackClaims, digestDate: "2026-02-30" },
    { ...feedbackClaims, expiresAt: Number.NaN },
    { ...feedbackClaims, itemId: "not-a-uuid" },
    { ...feedbackClaims, nonce: "raw-nonce" },
    { ...feedbackClaims, rating: "maybe" as "up" },
    { ...feedbackClaims, version: "v2" as "v1" },
  ])("rejects malformed verified claims before calling the RPC", async (claims) => {
    await expect(redeemFeedbackToken(claims)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.redeem",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("types provider failure without leaking details", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST940", message: "private redemption detail" },
    });

    const error = await redeemFeedbackToken().catch((caught) => caught);

    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "feedback.redeem",
    });
    expect(String(error)).not.toContain("private redemption detail");
  });

  test("returns one exact recorded acknowledgement without sending raw capability material", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [
        {
          feedback_id: feedbackId,
          outcome: "recorded",
          persisted_digest_date: feedbackClaims.digestDate,
          persisted_item_id: itemId,
          persisted_rating: "up",
          redeemed_at: createdAt,
        },
      ],
      error: null,
    });

    await expect(redeemFeedbackToken()).resolves.toEqual({
      digestDate: feedbackClaims.digestDate,
      feedbackId,
      itemId,
      ok: true,
      rating: "up",
      redeemedAt: createdAt,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("redeem_feedback_token", {
      p_digest_date: feedbackClaims.digestDate,
      p_expires_at: "2026-08-03T16:00:00.000Z",
      p_item_id: itemId,
      p_nonce_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_rating: "up",
      p_token_version: 1,
    });
    const serialized = JSON.stringify(mocks.rpc.mock.calls[0]);
    expect(serialized).not.toContain(feedbackClaims.nonce);
    expect(serialized).not.toContain("feedback-secret");
  });

  test.each(["already_redeemed", "expired", "invalid_context"] as const)(
    "returns the fixed %s domain outcome only when every persistence column is null",
    async (reason) => {
      mocks.rpc.mockResolvedValueOnce({
        data: [
          {
            feedback_id: null,
            outcome: reason,
            persisted_digest_date: null,
            persisted_item_id: null,
            persisted_rating: null,
            redeemed_at: null,
          },
        ],
        error: null,
      });

      await expect(redeemFeedbackToken()).resolves.toEqual({ ok: false, reason });
    },
  );

  test.each([
    { name: "null data", rows: null },
    { name: "no row", rows: [] },
    {
      name: "multiple rows",
      rows: [
        { outcome: "expired" },
        { outcome: "expired" },
      ],
    },
    {
      name: "database invalid_request",
      rows: [
        {
          feedback_id: null,
          outcome: "invalid_request",
          persisted_digest_date: null,
          persisted_item_id: null,
          persisted_rating: null,
          redeemed_at: null,
        },
      ],
    },
    {
      name: "failure outcome with leaked persistence data",
      rows: [
        {
          feedback_id: feedbackId,
          outcome: "already_redeemed",
          persisted_digest_date: null,
          persisted_item_id: null,
          persisted_rating: null,
          redeemed_at: null,
        },
      ],
    },
    {
      name: "recorded outcome with mismatched item",
      rows: [
        {
          feedback_id: feedbackId,
          outcome: "recorded",
          persisted_digest_date: feedbackClaims.digestDate,
          persisted_item_id: otherItemId,
          persisted_rating: "up",
          redeemed_at: createdAt,
        },
      ],
    },
  ])("rejects $name", async ({ rows }) => {
    mocks.rpc.mockResolvedValueOnce({ data: rows, error: null });

    await expect(redeemFeedbackToken()).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.redeem",
    });
  });
});

describe("saveFeedback acknowledgement", () => {
  test("rejects malformed input before querying", async () => {
    await expect(
      saveFeedback("not-a-uuid", "up", null, new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    await expect(
      saveFeedback(itemId, "maybe" as "up", null, new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    await expect(
      saveFeedback(itemId, "up", 7 as unknown as string, new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    await expect(
      saveFeedback(itemId, "up", null, new Date("invalid")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    await expect(
      saveFeedback(itemId, "up", "a".repeat(501), new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    await expect(
      saveFeedback(itemId, "up", "  ", new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("types provider failure without leaking details", async () => {
    const sentinel = "private feedback write detail";
    database({
      feedback: [{ data: null, error: { code: "PGRST930", message: sentinel } }],
    });
    const error = await saveFeedback(
      itemId,
      "up",
      null,
      new Date("2026-07-12T00:00:00Z"),
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "feedback.upsert",
    });
    expect(String(error)).not.toContain(sentinel);
  });

  test.each([
    { name: "null acknowledgement", row: null },
    {
      name: "mismatched item",
      row: {
        created_at: createdAt,
        digest_date: "2026-07-12",
        id: feedbackId,
        item_id: otherItemId,
        note: null,
        rating: "up",
      },
    },
    {
      name: "mismatched rating",
      row: {
        created_at: createdAt,
        digest_date: "2026-07-12",
        id: feedbackId,
        item_id: itemId,
        note: null,
        rating: "down",
      },
    },
    {
      name: "invalid persistence timestamp",
      row: {
        created_at: "2026-02-29T01:00:00Z",
        digest_date: "2026-07-12",
        id: feedbackId,
        item_id: itemId,
        note: null,
        rating: "up",
      },
    },
    {
      name: "invalid persistence id",
      row: {
        created_at: createdAt,
        digest_date: "2026-07-12",
        id: "not-a-uuid",
        item_id: itemId,
        note: null,
        rating: "up",
      },
    },
    {
      name: "mismatched note",
      row: {
        created_at: createdAt,
        digest_date: "2026-07-12",
        id: feedbackId,
        item_id: itemId,
        note: "different",
        rating: "up",
      },
    },
    {
      name: "mismatched digest date",
      row: {
        created_at: createdAt,
        digest_date: "2026-07-11",
        id: feedbackId,
        item_id: itemId,
        note: null,
        rating: "up",
      },
    },
    { name: "array acknowledgement", row: [] },
    {
      name: "multiple acknowledgement rows",
      row: [
        {
          created_at: createdAt,
          digest_date: "2026-07-12",
          id: feedbackId,
          item_id: itemId,
          note: null,
          rating: "up",
        },
        {
          created_at: createdAt,
          digest_date: "2026-07-12",
          id: "00000000-0000-4000-8000-000000000302",
          item_id: itemId,
          note: null,
          rating: "up",
        },
      ],
    },
  ])("rejects $name", async ({ row }) => {
    database({ feedback: [{ data: row, error: null }] });
    await expect(
      saveFeedback(itemId, "up", null, new Date("2026-07-12T00:00:00Z")),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "feedback.upsert",
    });
  });

  test("checks the exact persisted feedback payload", async () => {
    const note = "n".repeat(500);
    const fake = database({
      feedback: [
        {
          data: {
            created_at: createdAt,
            digest_date: "2026-07-13",
            id: feedbackId,
            item_id: itemId,
            note,
            rating: "down",
          },
          error: null,
        },
      ],
    });

    await expect(
      saveFeedback(itemId, "down", note, new Date("2026-07-12T16:00:00Z")),
    ).resolves.toBeUndefined();
    const query = fake.queries.get("feedback")?.[0];
    expect(query?.upsert).toHaveBeenCalledWith(
      {
        digest_date: "2026-07-13",
        item_id: itemId,
        note,
        rating: "down",
      },
      { onConflict: "item_id" },
    );
    expect(query?.select).toHaveBeenCalledWith(
      "id, item_id, rating, note, digest_date, created_at",
    );
    expect(query?.single).toHaveBeenCalledTimes(1);
  });

  test("normalizes an uppercase item UUID before persistence and acknowledgement", async () => {
    const fake = database({
      feedback: [
        {
          data: {
            created_at: createdAt,
            digest_date: "2026-07-12",
            id: feedbackId,
            item_id: letteredItemId,
            note: null,
            rating: "up",
          },
          error: null,
        },
      ],
    });

    await expect(
      saveFeedback(uppercaseItemId, "up", null, new Date("2026-07-12T00:00:00Z")),
    ).resolves.toBeUndefined();
    expect(fake.queries.get("feedback")?.[0].upsert).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: letteredItemId }),
      { onConflict: "item_id" },
    );
  });
});

describe("saveChat acknowledgement", () => {
  test("rejects malformed input before querying", async () => {
    await expect(saveChat("not-a-uuid", "user", "hello")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.insert",
    });
    await expect(saveChat(itemId, "system" as "user", "hello")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.insert",
    });
    await expect(saveChat(itemId, "user", "")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.insert",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("types provider failure without leaking details", async () => {
    const sentinel = "private chat insert detail";
    database({ chats: [{ data: null, error: { code: "PGRST931", message: sentinel } }] });
    const error = await saveChat(itemId, "user", "hello").catch((caught) => caught);
    expect(error).toMatchObject({ code: "DB_OPERATION_FAILED", operation: "chats.insert" });
    expect(String(error)).not.toContain(sentinel);

  });

  test.each([
    { name: "null acknowledgement", row: null },
    {
      name: "mismatched item",
      row: {
        content: "hello",
        created_at: createdAt,
        id: chatId,
        item_id: otherItemId,
        role: "user",
      },
    },
    {
      name: "invalid timestamp",
      row: {
        content: "hello",
        created_at: "2026-02-29T01:00:00Z",
        id: chatId,
        item_id: itemId,
        role: "user",
      },
    },
    {
      name: "invalid id",
      row: {
        content: "hello",
        created_at: createdAt,
        id: "not-a-uuid",
        item_id: itemId,
        role: "user",
      },
    },
    {
      name: "mismatched role",
      row: {
        content: "hello",
        created_at: createdAt,
        id: chatId,
        item_id: itemId,
        role: "assistant",
      },
    },
    {
      name: "mismatched content",
      row: {
        content: "different",
        created_at: createdAt,
        id: chatId,
        item_id: itemId,
        role: "user",
      },
    },
    { name: "array acknowledgement", row: [] },
    {
      name: "multiple acknowledgement rows",
      row: [
        {
          content: "hello",
          created_at: createdAt,
          id: chatId,
          item_id: itemId,
          role: "user",
        },
        {
          content: "hello",
          created_at: createdAt,
          id: "00000000-0000-4000-8000-000000000202",
          item_id: itemId,
          role: "user",
        },
      ],
    },
  ])("rejects $name", async ({ row }) => {
    database({ chats: [{ data: row, error: null }] });
    await expect(saveChat(itemId, "user", "hello")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "chats.insert",
    });
  });

  test("checks the exact persisted chat row", async () => {
    const fake = database({
      chats: [
        {
          data: {
            content: "answer",
            created_at: createdAt,
            id: chatId,
            item_id: itemId,
            role: "assistant",
          },
          error: null,
        },
      ],
    });
    await expect(saveChat(itemId, "assistant", "answer")).resolves.toBeUndefined();
    const query = fake.queries.get("chats")?.[0];
    expect(query?.insert).toHaveBeenCalledWith({
      item_id: itemId,
      role: "assistant",
      content: "answer",
    });
    expect(query?.select).toHaveBeenCalledWith("id, item_id, role, content, created_at");
    expect(query?.single).toHaveBeenCalledTimes(1);
  });

  test("normalizes an uppercase item UUID before persistence and acknowledgement", async () => {
    const fake = database({
      chats: [
        {
          data: {
            content: "hello",
            created_at: createdAt,
            id: chatId,
            item_id: letteredItemId,
            role: "user",
          },
          error: null,
        },
      ],
    });

    await expect(saveChat(uppercaseItemId, "user", "hello")).resolves.toBeUndefined();
    expect(fake.queries.get("chats")?.[0].insert).toHaveBeenCalledWith({
      content: "hello",
      item_id: letteredItemId,
      role: "user",
    });
  });
});

describe("addAnnotation acknowledgement", () => {
  const anchor = { points: [[1, 2], [3, 4]] };

  test("types provider failure without leaking details", async () => {
    const sentinel = "private annotation insert detail";
    database({
      annotations: [{ data: null, error: { code: "PGRST932", message: sentinel } }],
    });
    const error = await addAnnotation(itemId, "pen", anchor, "#e0c060", null).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "annotations.insert",
    });
    expect(String(error)).not.toContain(sentinel);
  });

  test.each([
    { name: "null acknowledgement", row: null },
    {
      name: "mismatched item",
      row: {
        anchor,
        body: null,
        color: "#e0c060",
        created_at: createdAt,
        id: annotationId,
        item_id: otherItemId,
        type: "pen",
      },
    },
    {
      name: "mismatched anchor",
      row: {
        anchor: { points: [[9, 9], [3, 4]] },
        body: null,
        color: "#e0c060",
        created_at: createdAt,
        id: annotationId,
        item_id: itemId,
        type: "pen",
      },
    },
    {
      name: "invalid persistence timestamp",
      row: {
        anchor,
        body: null,
        color: "#e0c060",
        created_at: "2026-02-29T01:00:00Z",
        id: annotationId,
        item_id: itemId,
        type: "pen",
      },
    },
    {
      name: "invalid persistence id",
      row: {
        anchor,
        body: null,
        color: "#e0c060",
        created_at: createdAt,
        id: "not-a-uuid",
        item_id: itemId,
        type: "pen",
      },
    },
    {
      name: "mismatched type",
      row: {
        anchor,
        body: null,
        color: "#e0c060",
        created_at: createdAt,
        id: annotationId,
        item_id: itemId,
        type: "highlight",
      },
    },
    {
      name: "mismatched color",
      row: {
        anchor,
        body: null,
        color: "#A0B1C2",
        created_at: createdAt,
        id: annotationId,
        item_id: itemId,
        type: "pen",
      },
    },
    {
      name: "mismatched body",
      row: {
        anchor,
        body: "different",
        color: "#e0c060",
        created_at: createdAt,
        id: annotationId,
        item_id: itemId,
        type: "pen",
      },
    },
    { name: "array acknowledgement", row: [] },
    {
      name: "multiple acknowledgement rows",
      row: [
        {
          anchor,
          body: null,
          color: "#e0c060",
          created_at: createdAt,
          id: annotationId,
          item_id: itemId,
          type: "pen",
        },
        {
          anchor,
          body: null,
          color: "#e0c060",
          created_at: createdAt,
          id: "00000000-0000-4000-8000-000000000102",
          item_id: itemId,
          type: "pen",
        },
      ],
    },
  ])("rejects $name", async ({ row }) => {
    database({ annotations: [{ data: row, error: null }] });
    await expect(
      addAnnotation(itemId, "pen", anchor, "#e0c060", null),
    ).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.insert",
    });
  });

  test("returns only a checked annotation DTO", async () => {
    const fake = database({
      annotations: [
        {
          data: {
            anchor,
            body: "note",
            color: "#A0B1C2",
            created_at: createdAt,
            id: annotationId,
            item_id: itemId,
            type: "pen",
          },
          error: null,
        },
      ],
    });

    await expect(
      addAnnotation(itemId, "pen", anchor, "#A0B1C2", "note"),
    ).resolves.toEqual({
      anchor,
      body: "note",
      color: "#A0B1C2",
      id: annotationId,
      type: "pen",
    });
    const query = fake.queries.get("annotations")?.[0];
    expect(query?.insert).toHaveBeenCalledWith({
      anchor,
      body: "note",
      color: "#A0B1C2",
      item_id: itemId,
      type: "pen",
    });
    expect(query?.select).toHaveBeenCalledWith(
      "id, item_id, type, anchor, color, body, created_at",
    );
    expect(query?.single).toHaveBeenCalledTimes(1);
  });

  test("normalizes uppercase UUID and JSONB numeric/object representations", async () => {
    const inputAnchor = { x: -0, y: 2 };
    const fake = database({
      annotations: [
        {
          data: {
            anchor: { y: 2, x: 0 },
            body: "note",
            color: "#e0c060",
            created_at: createdAt,
            id: annotationId,
            item_id: letteredItemId,
            type: "note",
          },
          error: null,
        },
      ],
    });

    await expect(
      addAnnotation(uppercaseItemId, "note", inputAnchor, "#e0c060", "note"),
    ).resolves.toEqual({
      anchor: { x: 0, y: 2 },
      body: "note",
      color: "#e0c060",
      id: annotationId,
      type: "note",
    });
    expect(fake.queries.get("annotations")?.[0].insert).toHaveBeenCalledWith({
      anchor: inputAnchor,
      body: "note",
      color: "#e0c060",
      item_id: letteredItemId,
      type: "note",
    });
  });
});

describe("deleteAnnotation acknowledgement", () => {
  test("rejects malformed input before querying", async () => {
    await expect(deleteAnnotation("not-a-uuid")).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.delete",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("types provider failure and distinguishes an absent row", async () => {
    const sentinel = "private annotation delete detail";
    database({
      annotations: [{ data: null, error: { code: "PGRST933", message: sentinel } }],
    });
    const error = await deleteAnnotation(annotationId).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "DB_OPERATION_FAILED",
      operation: "annotations.delete",
    });
    expect(String(error)).not.toContain(sentinel);

    database({ annotations: [{ data: [], error: null }] });
    await expect(deleteAnnotation(annotationId)).rejects.toMatchObject({
      code: "DB_NOT_FOUND",
      operation: "annotations.delete",
    });
  });

  test.each([
    { name: "null data", rows: null },
    { name: "a mismatched id", rows: [{ id: otherItemId }] },
    { name: "multiple rows", rows: [{ id: annotationId }, { id: annotationId }] },
  ])("rejects $name", async ({ rows }) => {
    database({ annotations: [{ data: rows, error: null }] });
    await expect(deleteAnnotation(annotationId)).rejects.toMatchObject({
      code: "DB_INTEGRITY_FAILED",
      operation: "annotations.delete",
    });
  });

  test("requires an exact delete acknowledgement", async () => {
    const fake = database({ annotations: [{ data: [{ id: annotationId }], error: null }] });
    await expect(deleteAnnotation(annotationId)).resolves.toBeUndefined();
    const query = fake.queries.get("annotations")?.[0];
    expect(query?.delete).toHaveBeenCalledTimes(1);
    expect(query?.eq).toHaveBeenCalledWith("id", annotationId);
    expect(query?.select).toHaveBeenCalledWith("id");
  });

  test("normalizes an uppercase UUID before deleting and checking acknowledgement", async () => {
    const fake = database({
      annotations: [{ data: [{ id: letteredAnnotationId }], error: null }],
    });
    await expect(deleteAnnotation(uppercaseAnnotationId)).resolves.toBeUndefined();
    const query = fake.queries.get("annotations")?.[0];
    expect(query?.eq).toHaveBeenCalledWith("id", letteredAnnotationId);
  });
});
