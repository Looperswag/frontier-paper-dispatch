import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname(),
}));

import ChatPanel from "../../components/ChatPanel";

const fetchMock = vi.fn<typeof fetch>();
const emptyPrompt = "基于这篇随便问——方法细节、能不能用进你的产品、和某篇的区别…";

beforeEach(() => {
  navigation.pathname.mockReset().mockReturnValue(
    "/paper/00000000-0000-4000-8000-000000000001",
  );
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

async function renderLoaded(postResponse: Response) {
  fetchMock
    .mockResolvedValueOnce(Response.json({ chats: [] }))
    .mockResolvedValueOnce(postResponse);
  const user = userEvent.setup();
  render(<ChatPanel />);
  await screen.findByText(emptyPrompt);
  const input = screen.getByRole("textbox");
  await user.type(input, "question{enter}");
  return { input, user };
}

describe("ChatPanel truthful HTTP state", () => {
  test("disables sending until history loading has completed", async () => {
    let resolveHistory: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveHistory = resolve;
      }),
    );
    render(<ChatPanel />);
    const input = screen.getByRole("textbox");

    expect(input).toBeDisabled();
    await act(async () => {
      resolveHistory?.(Response.json({ chats: [] }));
    });
    await screen.findByText(emptyPrompt);
    expect(input).not.toBeDisabled();
  });

  test("shows a distinct history error instead of a normal empty state", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "private server detail" }, { status: 503 }),
    );
    render(<ChatPanel />);

    await expect(screen.findByText("历史加载失败，请刷新重试")).resolves.toBeInTheDocument();
    expect(screen.queryByText(emptyPrompt)).not.toBeInTheDocument();
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
  });

  test("rejects malformed history rows instead of rendering them", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ chats: [{ role: "system", content: 7 }] }),
    );
    render(<ChatPanel />);

    await expect(screen.findByText("历史加载失败，请刷新重试")).resolves.toBeInTheDocument();
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  test("does not display a non-2xx body as an assistant answer", async () => {
    await renderLoaded(new Response("private internal error", { status: 500 }));

    await expect(screen.findByText("（出错了，请重试）")).resolves.toBeInTheDocument();
    expect(screen.getByText("question（未确认保存）")).toBeInTheDocument();
    expect(screen.queryByText("private internal error")).not.toBeInTheDocument();
  });

  test("treats an empty successful stream as a failure", async () => {
    await renderLoaded(new Response("", { status: 200 }));

    await expect(screen.findByText("（出错了，请重试）")).resolves.toBeInTheDocument();
  });

  test("still renders a successful streamed answer and releases the input", async () => {
    const { input } = await renderLoaded(new Response("complete answer", { status: 200 }));

    await expect(screen.findByText("complete answer")).resolves.toBeInTheDocument();
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  test("cancels an old paper stream and prevents it from overwriting new history", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamCancelled = false;
    const oldStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        streamCancelled = true;
      },
    });
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "POST") return Promise.resolve(new Response(oldStream));
      if (url.includes("00000000-0000-4000-8000-000000000002")) {
        return Promise.resolve(
          Response.json({ chats: [{ role: "assistant", content: "new paper history" }] }),
        );
      }
      return Promise.resolve(Response.json({ chats: [] }));
    });
    const user = userEvent.setup();
    const view = render(<ChatPanel />);
    await screen.findByText(emptyPrompt);
    await user.type(screen.getByRole("textbox"), "old question{enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    navigation.pathname.mockReturnValue(
      "/paper/00000000-0000-4000-8000-000000000002",
    );
    view.rerender(<ChatPanel />);
    await screen.findByText("new paper history");

    if (!streamCancelled) {
      await act(async () => {
        streamController?.enqueue(new TextEncoder().encode("old answer"));
        streamController?.close();
      });
    }
    expect(streamCancelled).toBe(true);
    expect(screen.getByText("new paper history")).toBeInTheDocument();
    expect(screen.queryByText("old answer")).not.toBeInTheDocument();
  });
});
