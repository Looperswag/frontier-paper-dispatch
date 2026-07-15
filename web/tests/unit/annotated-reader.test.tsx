import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import AnnotatedReader from "../../components/AnnotatedReader";

const fetchMock = vi.fn<typeof fetch>();
const initialNote = {
  anchor: { x: 1, y: 2 },
  body: "existing note",
  color: "#e0c060",
  id: "00000000-0000-4000-8000-000000000101",
  type: "note" as const,
};

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderReader(initial = [initialNote], contentVersion?: string) {
  return render(
    <AnnotatedReader
      paperId="00000000-0000-4000-8000-000000000001"
      initial={initial}
      contentVersion={contentVersion}
    >
      <p>paper content</p>
    </AnnotatedReader>,
  );
}

describe("AnnotatedReader truthful mutation state", () => {
  test("exposes one keyboard toolbar state and a truthful browser-print PDF action", async () => {
    const user = userEvent.setup();
    renderReader();
    const highlight = screen.getByRole("button", { name: "高亮" });
    expect(screen.getByRole("toolbar", { name: "阅读批注与导出工具" })).toBeInTheDocument();
    expect(highlight).toHaveAttribute("aria-pressed", "false");
    await user.click(highlight);
    expect(highlight).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "PDF" })).toHaveAttribute(
      "title",
      "使用浏览器打印为 PDF",
    );
  });

  test("keeps an annotation and shows an error when DELETE fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("failed", { status: 500 }));
    const user = userEvent.setup();
    const { container } = renderReader();
    await user.click(screen.getByRole("button", { name: "擦" }));

    await user.click(container.querySelector(".anno-note") as HTMLElement);

    await expect(screen.findByText("批注删除失败，请重试")).resolves.toBeInTheDocument();
    expect(container.querySelector(".anno-note")).toBeInTheDocument();
  });

  test("removes an annotation only after DELETE succeeds", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    const user = userEvent.setup();
    const { container } = renderReader();
    await user.click(screen.getByRole("button", { name: "擦" }));

    await user.click(container.querySelector(".anno-note") as HTMLElement);

    await waitFor(() => expect(container.querySelector(".anno-note")).not.toBeInTheDocument());
    expect(screen.queryByText("批注删除失败，请重试")).not.toBeInTheDocument();
  });

  test("does not issue concurrent DELETE requests for the same annotation", async () => {
    let resolveDelete: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    const user = userEvent.setup();
    const { container } = renderReader();
    await user.click(screen.getByRole("button", { name: "擦" }));
    const note = container.querySelector(".anno-note") as HTMLElement;

    await user.click(note);
    await user.click(note);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveDelete?.(Response.json({ ok: true }));
    await waitFor(() => expect(container.querySelector(".anno-note")).not.toBeInTheDocument());
  });

  test("keeps an annotation when DELETE returns a malformed success envelope", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false }));
    const user = userEvent.setup();
    const { container } = renderReader();
    await user.click(screen.getByRole("button", { name: "擦" }));

    await user.click(container.querySelector(".anno-note") as HTMLElement);

    await expect(screen.findByText("批注删除失败，请重试")).resolves.toBeInTheDocument();
    expect(container.querySelector(".anno-note")).toBeInTheDocument();
  });

  test("shows a visible error and does not add a note when POST fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    vi.spyOn(window, "prompt").mockReturnValue("new note");
    const user = userEvent.setup();
    const { container } = renderReader([]);
    await user.click(screen.getByRole("button", { name: "便签" }));

    fireEvent.pointerDown(container.querySelector("svg.anno-svg") as SVGElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
    });

    await expect(screen.findByText("批注保存失败，请重试")).resolves.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("批注保存失败，请重试");
    expect(container.querySelector(".anno-note")).not.toBeInTheDocument();
  });

  test("stores new note geometry as a normalized content-versioned anchor", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      toJSON: () => ({}),
      top: 0,
      width: 200,
      x: 0,
      y: 0,
    });
    const contentVersion = "b".repeat(64);
    const created = {
      ...initialNote,
      anchor: { contentVersion, v: 2, x: 0.5, y: 0.5 },
      body: "normalized note",
      id: "00000000-0000-4000-8000-000000000103",
    };
    fetchMock.mockResolvedValueOnce(Response.json(created, { status: 201 }));
    vi.spyOn(window, "prompt").mockReturnValue("normalized note");
    const user = userEvent.setup();
    const { container } = renderReader([], contentVersion);
    await user.click(screen.getByRole("button", { name: "便签" }));

    fireEvent.pointerDown(container.querySelector("svg.anno-svg") as SVGElement, {
      clientX: 100,
      clientY: 50,
      pointerId: 1,
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      anchor: { contentVersion, v: 2, x: 0.5, y: 0.5 },
      type: "note",
    });
  });

  test("hides stale versioned geometry instead of projecting it onto changed content", async () => {
    const oldVersion = "a".repeat(64);
    const newVersion = "b".repeat(64);
    const stale = [
      {
        anchor: {
          contentVersion: oldVersion,
          prefix: "",
          quote: "removed quote",
          rects: [{ h: 0.1, w: 0.2, x: 0.1, y: 0.1 }],
          suffix: "",
          v: 2 as const,
        },
        body: "removed quote",
        color: "#e0c060",
        id: "00000000-0000-4000-8000-000000000104",
        type: "highlight" as const,
      },
      {
        anchor: { contentVersion: oldVersion, v: 2 as const, x: 0.5, y: 0.5 },
        body: "stale note",
        color: "#e0c060",
        id: "00000000-0000-4000-8000-000000000105",
        type: "note" as const,
      },
      {
        anchor: { contentVersion: oldVersion, h: 0.2, v: 2 as const, w: 0.2, x: 0.1, y: 0.1 },
        body: null,
        color: "#8a3324",
        id: "00000000-0000-4000-8000-000000000107",
        type: "box" as const,
      },
      {
        anchor: {
          contentVersion: oldVersion,
          points: [[0.1, 0.1], [0.2, 0.2]],
          v: 2 as const,
        },
        body: null,
        color: "#4a6a8a",
        id: "00000000-0000-4000-8000-000000000108",
        type: "pen" as const,
      },
    ];
    const { container } = renderReader(stale, newVersion);

    await waitFor(() => expect(container.querySelector("svg rect")).not.toBeInTheDocument());
    expect(container.querySelector("svg polyline")).not.toBeInTheDocument();
    expect(container.querySelector(".anno-note")).not.toBeInTheDocument();
    expect(screen.getByText("4 个旧版本批注已隐藏")).toBeInTheDocument();
  });

  test("bounds a long pen gesture before sending it to the API", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 1_000,
      height: 1_000,
      left: 0,
      right: 800,
      toJSON: () => ({}),
      top: 0,
      width: 800,
      x: 0,
      y: 0,
    });
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        ...request,
        id: "00000000-0000-4000-8000-000000000106",
      }, { status: 201 });
    });
    const user = userEvent.setup();
    const { container } = renderReader([], "c".repeat(64));
    await user.click(screen.getByRole("button", { name: "画笔" }));
    const canvas = container.querySelector("svg.anno-svg") as SVGElement;
    fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1, pointerId: 1 });
    for (let index = 2; index <= 700; index += 1) {
      fireEvent.pointerMove(canvas, { clientX: index % 800, clientY: index, pointerId: 1 });
    }
    fireEvent.pointerUp(canvas, { clientX: 700, clientY: 700, pointerId: 1 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(request.anchor.points.length).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(JSON.stringify(request.anchor)).byteLength).toBeLessThanOrEqual(20_000);
  });

  test("adds only the server-acknowledged annotation after POST succeeds", async () => {
    const created = {
      ...initialNote,
      anchor: { x: 10, y: 20 },
      body: "new note",
      id: "00000000-0000-4000-8000-000000000102",
    };
    fetchMock.mockResolvedValueOnce(Response.json(created, { status: 201 }));
    vi.spyOn(window, "prompt").mockReturnValue("new note");
    const user = userEvent.setup();
    const { container } = renderReader([]);
    await user.click(screen.getByRole("button", { name: "便签" }));

    fireEvent.pointerDown(container.querySelector("svg.anno-svg") as SVGElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
    });

    await waitFor(() => expect(container.querySelectorAll(".anno-note")).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("rejects a malformed annotation success DTO", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "not-a-uuid" }, { status: 201 }));
    vi.spyOn(window, "prompt").mockReturnValue("new note");
    const user = userEvent.setup();
    const { container } = renderReader([]);
    await user.click(screen.getByRole("button", { name: "便签" }));

    fireEvent.pointerDown(container.querySelector("svg.anno-svg") as SVGElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
    });

    await expect(screen.findByText("批注保存失败，请重试")).resolves.toBeInTheDocument();
    expect(container.querySelector(".anno-note")).not.toBeInTheDocument();
  });

  test.each([
    { name: "an invalid color", value: { ...initialNote, color: "yellow" } },
    {
      name: "an incomplete box anchor",
      value: { ...initialNote, anchor: { x: 10, y: 20 }, type: "box" },
    },
  ])("rejects $name in an otherwise successful response", async ({ value }) => {
    fetchMock.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    vi.spyOn(window, "prompt").mockReturnValue("new note");
    const user = userEvent.setup();
    const { container } = renderReader([]);
    await user.click(screen.getByRole("button", { name: "便签" }));

    fireEvent.pointerDown(container.querySelector("svg.anno-svg") as SVGElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 1,
    });

    await expect(screen.findByText("批注保存失败，请重试")).resolves.toBeInTheDocument();
    expect(container.querySelector(".anno-note")).not.toBeInTheDocument();
  });
});
