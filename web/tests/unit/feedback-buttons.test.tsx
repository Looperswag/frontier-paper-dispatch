import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FeedbackButtons from "../../components/FeedbackButtons";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeedbackButtons truthful save state", () => {
  test.each([
    {
      name: "an HTTP failure",
      response: () => Promise.resolve(new Response("failed", { status: 500 })),
    },
    {
      name: "a network failure",
      response: () => Promise.reject(new Error("offline")),
    },
  ])("rolls back and shows an error after $name", async ({ response }) => {
    fetchMock.mockImplementationOnce(response);
    const user = userEvent.setup();
    render(<FeedbackButtons itemId="paper" initialRating="up" />);

    await user.click(screen.getByRole("button", { name: "不相关" }));

    await waitFor(() => expect(screen.getByText("记录失败，请重试")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "有用" })).toHaveClass("on");
    expect(screen.getByRole("button", { name: "不相关" })).not.toHaveClass("on");
    expect(screen.queryByText("已记录 ✓")).not.toBeInTheDocument();
  });

  test("updates the rating and success state only after an HTTP success", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    const user = userEvent.setup();
    render(<FeedbackButtons itemId="paper" initialRating="up" />);

    await user.click(screen.getByRole("button", { name: "不相关" }));

    await waitFor(() => expect(screen.getByText("已记录 ✓")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "不相关" })).toHaveClass("on");
    expect(screen.queryByText("记录失败，请重试")).not.toBeInTheDocument();
  });

  test("rejects a malformed success envelope", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false }));
    const user = userEvent.setup();
    render(<FeedbackButtons itemId="paper" initialRating="up" />);

    await user.click(screen.getByRole("button", { name: "不相关" }));

    await expect(screen.findByText("记录失败，请重试")).resolves.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "有用" })).toHaveClass("on");
  });

  test("a previous success timer cannot clear a newer success message", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
      render(<FeedbackButtons itemId="paper" initialRating="up" />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "不相关" }));
        await Promise.resolve();
      });
      expect(screen.getByText("已记录 ✓")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_000));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "有用" }));
        await Promise.resolve();
      });
      act(() => vi.advanceTimersByTime(600));

      expect(screen.getByText("已记录 ✓")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(900));
      expect(screen.queryByText("已记录 ✓")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
