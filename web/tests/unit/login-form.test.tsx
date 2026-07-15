import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import LoginForm from "../../components/LoginForm";

const fetchMock = vi.fn<typeof fetch>();
const replace = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { replace });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("single-owner password login form", () => {
  test("asks only for a password and never renders an owner identifier", () => {
    render(<LoginForm />);

    expect(screen.getByLabelText("访问口令")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("textbox", { name: /email|邮箱/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/owner@example\.com/i);
  });

  test("posts only the unchanged password and hard-navigates to the validated return path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    render(<LoginForm returnTo="/feedback?token=v1_example-token" />);

    await user.type(screen.getByLabelText("访问口令"), " password with spaces ");
    await user.click(screen.getByRole("button", { name: "进入情报台" }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/feedback?token=v1_example-token"),
    );
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe("/api/auth/login");
    expect(request[1]).toMatchObject({ method: "POST" });
    expect(String(request[1]?.body)).toBe("password=+password+with+spaces+");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not navigate while the login request is still pending", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm returnTo="/paper/one?from=digest" />);

    await user.type(screen.getByLabelText("访问口令"), "correct password");
    await user.click(screen.getByRole("button", { name: "进入情报台" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "验证中…" })).toBeDisabled();
    expect(replace).not.toHaveBeenCalled();

    resolveResponse?.(new Response(null, { status: 204 }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/paper/one?from=digest"));
  });

  test.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/%255cattacker.example/steal",
    "/%2525G0",
    "/api/private",
    "/login?returnTo=/paper/one",
  ])("defensively hard-navigates to home for unsafe prop %s", async (returnTo) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    render(<LoginForm returnTo={returnTo} />);

    await user.type(screen.getByLabelText("访问口令"), "correct password");
    await user.click(screen.getByRole("button", { name: "进入情报台" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  test.each([
    { message: "登录失败，请检查口令后重试", status: 401 },
    { message: "尝试过于频繁，请稍后再试", status: 429 },
    { message: "登录服务暂不可用，请稍后再试", status: 503 },
  ])("shows a fixed local message for HTTP $status", async ({ message, status }) => {
    fetchMock.mockResolvedValueOnce(
      new Response("private owner and upstream detail", { status }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("访问口令"), "wrong");
    await user.click(screen.getByRole("button", { name: "进入情报台" }));

    await expect(screen.findByRole("status")).resolves.toHaveTextContent(message);
    expect(document.body.textContent).not.toContain("private owner and upstream detail");
    expect(replace).not.toHaveBeenCalled();
  });

  test("rejects a password over the server byte limit before making a request", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("访问口令"), "界".repeat(342));
    await user.click(screen.getByRole("button", { name: "进入情报台" }));

    await expect(screen.findByRole("status")).resolves.toHaveTextContent(
      "口令过长，请检查后重试",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses a document navigation instead of the Next router cache", () => {
    const source = readFileSync(resolve(process.cwd(), "components/LoginForm.tsx"), "utf8");

    expect(source).not.toMatch(/next\/navigation|useRouter|router\.replace|router\.refresh/);
    expect(source).toContain("globalThis.location.replace");
  });
});
