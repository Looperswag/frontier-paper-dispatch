import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAPI: vi.fn(),
  getAnnotations: vi.fn(),
  getPaper: vi.fn(),
  packDocx: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-boundary", () => ({ authorizeAPI: mocks.authorizeAPI }));
vi.mock("@/lib/data", () => ({
  getAnnotations: mocks.getAnnotations,
  getPaper: mocks.getPaper,
}));
vi.mock("docx", () => ({
  Document: class {
    constructor(readonly options: unknown) {}
  },
  HeadingLevel: { HEADING_1: "h1", HEADING_2: "h2" },
  Packer: { toBuffer: mocks.packDocx },
  Paragraph: class {
    constructor(readonly options: unknown) {}
  },
  TextRun: class {
    constructor(readonly options: unknown) {}
  },
}));

import { GET } from "../../app/api/export/[id]/route";

const itemId = "00000000-0000-4000-8000-000000000001";
const owner = {
  email: "owner@example.com",
  userId: "00000000-0000-4000-8000-000000000701",
};
const paper = {
  abstract: "abstract",
  authors: ["Author"],
  id: itemId,
  source: "arxiv",
  summary: {
    impact_md: "impact",
    one_liner: "one line",
    summary_md: "summary",
  },
  title: "Owner Paper",
  url: "https://example.com/paper",
};

function exportRequest(query = "?format=md", id = itemId) {
  return GET(new Request(`https://papers.example.com/api/export/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
}

async function expectAPIError(response: Response, status: number, code: string) {
  const messages: Record<string, string> = {
    INTERNAL_ERROR: "Internal error",
    INVALID_REQUEST: "Invalid request",
    NOT_FOUND: "Resource not found",
    SERVICE_UNAVAILABLE: "Service unavailable",
  };
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({
    error: { code, message: messages[code] },
    ok: false,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

function expectPrivateAttachment(response: Response) {
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Expires")).toBe("0");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
}

beforeEach(() => {
  mocks.authorizeAPI.mockReset().mockResolvedValue({
    ok: true,
    owner,
  });
  mocks.getPaper.mockReset().mockResolvedValue(paper);
  mocks.getAnnotations.mockReset().mockResolvedValue([
    { body: "private note", id: itemId, type: "note" },
  ]);
  mocks.packDocx.mockReset().mockResolvedValue(Buffer.from("docx-bytes"));
});

describe("owner export success paths", () => {
  test("returns markdown after owner authorization and data reads", async () => {
    const response = await GET(
      new Request(`https://papers.example.com/api/export/${itemId}?format=md`),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expectPrivateAttachment(response);
    expect(await response.text()).toContain("# Owner Paper");
    expect(mocks.authorizeAPI).toHaveBeenCalledTimes(1);
    expect(mocks.getPaper).toHaveBeenCalledWith(owner, itemId);
    expect(mocks.getAnnotations).toHaveBeenCalledWith(owner, itemId);
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test("packs Word only after owner authorization and successful data reads", async () => {
    const response = await GET(
      new Request(`https://papers.example.com/api/export/${itemId}?format=docx`),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expectPrivateAttachment(response);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("docx-bytes");
    expect(mocks.authorizeAPI).toHaveBeenCalledTimes(1);
    expect(mocks.getPaper).toHaveBeenCalledWith(owner, itemId);
    expect(mocks.getAnnotations).toHaveBeenCalledWith(owner, itemId);
    expect(mocks.packDocx).toHaveBeenCalledTimes(1);
  });

  test("defaults a missing format to Markdown", async () => {
    const response = await exportRequest("");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test("canonicalizes a valid uppercase path UUID before both data reads", async () => {
    const uppercase = "ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB";
    const response = await exportRequest("?format=md", uppercase);

    expect(response.status).toBe(200);
    expect(mocks.getPaper).toHaveBeenCalledWith(owner, uppercase.toLowerCase());
    expect(mocks.getAnnotations).toHaveBeenCalledWith(owner, uppercase.toLowerCase());
  });
});

describe("owner export request boundary", () => {
  test("does not inspect params or the URL before authorization succeeds", async () => {
    let paramsReads = 0;
    let urlReads = 0;
    const params = {
      then() {
        paramsReads += 1;
        throw new Error("params read before authorization");
      },
    } as unknown as Promise<{ id: string }>;
    const request = Object.defineProperty({}, "url", {
      get() {
        urlReads += 1;
        throw new Error("URL read before authorization");
      },
    }) as Request;
    mocks.authorizeAPI.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    });

    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    expect(paramsReads).toBe(0);
    expect(urlReads).toBe(0);
    expect(mocks.getPaper).not.toHaveBeenCalled();
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test.each([
    ["an invalid path UUID", "?format=md", "not-a-uuid"],
    ["an empty format", "?format=", itemId],
    ["an unsupported format", "?format=pdf", itemId],
    ["duplicate format", "?format=md&format=docx", itemId],
    ["an unknown query", "?format=md&extra=1", itemId],
  ])("rejects %s before reading private data", async (_name, query, id) => {
    const response = await exportRequest(query, id);

    await expectAPIError(response, 400, "INVALID_REQUEST");
    expect(mocks.getPaper).not.toHaveBeenCalled();
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });
});

describe("owner export truthful failures", () => {
  test("returns a fixed 404 and stops when the paper does not exist", async () => {
    mocks.getPaper.mockResolvedValueOnce(null);

    const response = await exportRequest();

    await expectAPIError(response, 404, "NOT_FOUND");
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test.each([
    ["DB_NOT_FOUND", 404, "NOT_FOUND"],
    ["DB_OPERATION_FAILED", 503, "SERVICE_UNAVAILABLE"],
    ["DB_INTEGRITY_FAILED", 500, "INTERNAL_ERROR"],
    [undefined, 500, "INTERNAL_ERROR"],
  ])("maps a paper read %s without leaking details", async (errorCode, status, code) => {
    mocks.getPaper.mockRejectedValueOnce(
      Object.assign(
        new Error("private paper detail"),
        errorCode === undefined ? {} : { code: errorCode },
      ),
    );

    const response = await exportRequest();

    await expectAPIError(response, status, code);
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test("maps an annotation read failure and skips document packing", async () => {
    mocks.getAnnotations.mockRejectedValueOnce(
      Object.assign(new Error("private annotation detail"), { code: "DB_OPERATION_FAILED" }),
    );

    const response = await exportRequest("?format=docx");

    await expectAPIError(response, 503, "SERVICE_UNAVAILABLE");
    expect(mocks.packDocx).not.toHaveBeenCalled();
  });

  test("maps document packing failure to a fixed private 500", async () => {
    mocks.packDocx.mockRejectedValueOnce(new Error("private pack detail"));

    const response = await exportRequest("?format=docx");

    await expectAPIError(response, 500, "INTERNAL_ERROR");
  });
});
