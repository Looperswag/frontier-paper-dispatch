import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: Object.freeze({ email: "owner@example.com", userId: "00000000-0000-4000-8000-000000000001" }),
  requireOwnerPage: vi.fn(),
  searchPapers: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ requireOwnerPage: mocks.requireOwnerPage }));
vi.mock("../../lib/auth-boundary", () => ({ requireOwnerPage: mocks.requireOwnerPage }));
vi.mock("@/lib/data", () => ({ searchPapers: mocks.searchPapers }));
vi.mock("../../lib/data", () => ({ searchPapers: mocks.searchPapers }));

import SearchPage from "../../app/(private)/search/page";

beforeEach(() => {
  mocks.requireOwnerPage.mockReset().mockResolvedValue(mocks.owner);
  mocks.searchPapers.mockReset().mockResolvedValue([]);
});

describe("SearchPage", () => {
  test.each([
    ["empty query", {}, "在左栏搜索框输入关键词，检索最近最多 500 篇有摘要项目。"],
    ["nonempty query", { q: "RAG" }, "在最近最多 500 篇有摘要项目中命中 0 篇"],
  ])("states the bounded archive scope for %s", async (_name, searchParams, expected) => {
    render(await SearchPage({ searchParams: Promise.resolve(searchParams) }));

    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(/全部论文/)).not.toBeInTheDocument();
    if ("q" in searchParams) {
      expect(mocks.searchPapers).toHaveBeenCalledWith(mocks.owner, "RAG");
    } else {
      expect(mocks.searchPapers).not.toHaveBeenCalled();
    }
  });
});
