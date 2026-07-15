import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FeedbackConfirmation from "../../components/FeedbackConfirmation";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("feedback confirmation", () => {
  test("does not consume the token until the owner explicitly confirms", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, rating: "up" }));
    const user = userEvent.setup();
    render(<FeedbackConfirmation token="signed-token" rating="up" />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/尚未记录/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认记录为有用" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已记录"));
    expect(screen.queryByText(/尚未记录/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/feedback/redeem", {
      body: JSON.stringify({ token: "signed-token" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  test.each([
    [409, "这条反馈已经记录过"],
    [410, "链接无效或已过期"],
    [503, "记录服务暂不可用"],
  ])("shows a fixed message for HTTP %i", async (status, message) => {
    fetchMock.mockResolvedValueOnce(new Response("private detail", { status }));
    const user = userEvent.setup();
    render(<FeedbackConfirmation token="signed-token" rating="down" />);

    await user.click(screen.getByRole("button", { name: "确认记录为不相关" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(document.body.textContent).not.toContain("private detail");
    if (status === 409) expect(screen.queryByText(/尚未记录/)).not.toBeInTheDocument();
  });

  test("rejects a malformed success envelope", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, rating: "down" }));
    const user = userEvent.setup();
    render(<FeedbackConfirmation token="signed-token" rating="up" />);

    await user.click(screen.getByRole("button", { name: "确认记录为有用" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("记录失败"));
  });
});
