import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import PrivateError from "../../app/(private)/error";
import PrivateLoading from "../../app/(private)/loading";
import PrivateNotFound from "../../app/(private)/not-found";

afterEach(cleanup);

describe("private route states", () => {
  test("announces loading without presenting stale content as complete", () => {
    render(<PrivateLoading />);
    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("尚未完成加载");
  });

  test("shows a fixed retryable error without private exception details", async () => {
    const reset = vi.fn();
    render(<PrivateError error={new Error("private Supabase owner detail")} reset={reset} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Supabase|owner detail/i);
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  test("provides a keyboard link out of a missing paper", () => {
    render(<PrivateNotFound />);
    expect(screen.getByRole("link", { name: "返回最新简报" })).toHaveAttribute("href", "/");
  });
});
