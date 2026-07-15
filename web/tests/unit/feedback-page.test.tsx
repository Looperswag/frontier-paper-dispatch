import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnerPage: vi.fn(),
  verifyFeedbackToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth-boundary", () => ({ requireOwnerPage: mocks.requireOwnerPage }));
vi.mock("../../lib/sign", () => ({ verifyFeedbackToken: mocks.verifyFeedbackToken }));

import FeedbackPage, { metadata } from "../../app/feedback/page";

const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};
const token = `v1.${"t".repeat(120)}`;

beforeEach(() => {
  mocks.requireOwnerPage.mockReset().mockResolvedValue(owner);
  mocks.verifyFeedbackToken.mockReset().mockReturnValue({
    digestDate: "2026-07-13",
    expiresAt: 1_785_772_800,
    itemId: "00000000-0000-4000-8000-000000000001",
    nonce: "n".repeat(43),
    rating: "up",
    version: "v1",
  });
});

describe("owner-only feedback confirmation page", () => {
  test("authorizes before inspecting query input", async () => {
    let inspected = false;
    const searchParams = {
      then() {
        inspected = true;
        throw new Error("query should not be read");
      },
    } as unknown as Promise<Record<string, string>>;
    mocks.requireOwnerPage.mockRejectedValueOnce(new Error("auth denied"));

    await expect(FeedbackPage({ searchParams })).rejects.toThrow("auth denied");
    expect(inspected).toBe(false);
    expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
  });

  test("renders an inert confirmation without consuming or exposing the token", async () => {
    const element = await FeedbackPage({ searchParams: Promise.resolve({ token }) });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain("尚未记录");
    expect(markup).toContain("确认记录为有用");
    expect(markup).not.toContain(token);
    expect(mocks.verifyFeedbackToken).toHaveBeenCalledWith(token);
  });

  test.each([
    {},
    { extra: "x", token },
    { token: [token, token] },
    { token: "x".repeat(257) },
  ])("rejects ambiguous or invalid query without verification", async (searchParams) => {
    const element = await FeedbackPage({
      searchParams: Promise.resolve(searchParams as Record<string, string | string[]>),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain("链接无效或已过期");
    expect(mocks.verifyFeedbackToken).not.toHaveBeenCalled();
  });

  test("uses non-indexing and no-referrer metadata", () => {
    expect(metadata).toMatchObject({
      referrer: "no-referrer",
      robots: { follow: false, index: false },
    });
  });
});
