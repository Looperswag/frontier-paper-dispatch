import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import GlobalError from "../../app/global-error";

afterEach(cleanup);

test("renders a fixed recovery message without exposing the server error", () => {
  const reset = vi.fn();
  render(
    <GlobalError
      error={new Error("private owner@example.com Supabase and database detail")}
      reset={reset}
    />,
  );

  expect(screen.getByRole("heading")).toHaveTextContent("电讯中断");
  expect(screen.getByText("服务暂时不可用，请稍后重试。")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/owner@example\.com|Supabase|database detail/i);
});
