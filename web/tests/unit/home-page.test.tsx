import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTop5: vi.fn(),
  owner: Object.freeze({
    email: "owner@example.com",
    userId: "00000000-0000-4000-8000-000000000001",
  }),
  requireOwnerPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/components/FeedbackButtons", () => ({ default: () => null }));
vi.mock("../../components/FeedbackButtons", () => ({ default: () => null }));
vi.mock("@/lib/auth-boundary", () => ({ requireOwnerPage: mocks.requireOwnerPage }));
vi.mock("../../lib/auth-boundary", () => ({ requireOwnerPage: mocks.requireOwnerPage }));
vi.mock("@/lib/data", () => ({ getTop5: mocks.getTop5 }));
vi.mock("../../lib/data", () => ({ getTop5: mocks.getTop5 }));

import Home from "../../app/(private)/page";

beforeEach(() => {
  mocks.requireOwnerPage.mockReset().mockResolvedValue(mocks.owner);
  mocks.getTop5.mockReset().mockResolvedValue({ date: null, papers: [] });
});

describe("Home", () => {
  test("directs an empty archive to run ingest from the repository root", async () => {
    render(await Home());

    const article = screen.getByRole("article");
    expect(article).toHaveTextContent(
      "数据库里还没有 digest。请先在仓库根目录运行 npm run ingest，再回来刷新。",
    );
    expect(article).not.toHaveTextContent("平台/");
  });
});
