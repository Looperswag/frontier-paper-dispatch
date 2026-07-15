import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mocks.from }),
}));
vi.mock("server-only", () => ({}));

import { saveFeedback as saveFeedbackWithOwner } from "@/lib/data";
import type { OwnerContext } from "@/lib/auth";

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

beforeEach(() => {
  const query: Record<string, unknown> & PromiseLike<unknown> = {
    then: (resolve, reject) =>
      Promise.resolve({
        data: {
          created_at: "2026-07-10T00:00:00.000Z",
          digest_date: "2026-07-10",
          id: "00000000-0000-4000-8000-000000000002",
          item_id: "00000000-0000-4000-8000-000000000001",
          note: null,
          rating: "up",
        },
        error: null,
      }).then(resolve, reject),
  };
  mocks.upsert.mockReset().mockReturnValue(query);
  mocks.select.mockReset().mockReturnValue(query);
  mocks.single.mockReset().mockReturnValue(query);
  query.upsert = mocks.upsert;
  query.select = mocks.select;
  query.single = mocks.single;
  mocks.from.mockReset().mockReturnValue(query);
});

test("saveFeedback persists the Asia/Shanghai date for the supplied instant", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-08T12:00:00.000Z"));
  try {
    await saveFeedback(
      "00000000-0000-4000-8000-000000000001",
      "up",
      null,
      new Date("2026-07-09T16:00:00.000Z"),
    );
  } finally {
    vi.useRealTimers();
  }

  expect(mocks.from).toHaveBeenCalledWith("feedback");
  expect(mocks.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ digest_date: "2026-07-10" }),
    { onConflict: "item_id" },
  );
});
