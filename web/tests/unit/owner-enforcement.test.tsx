import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAnnotation: vi.fn(),
  createCompletion: vi.fn(),
  deleteAnnotation: vi.fn(),
  getAnnotations: vi.fn(),
  getChats: vi.fn(),
  getPaper: vi.fn(),
  getTop5: vi.fn(),
  listArchive: vi.fn(),
  packDocx: vi.fn(),
  redirect: vi.fn(),
  redeemFeedbackToken: vi.fn(),
  requireOwner: vi.fn(),
  saveChat: vi.fn(),
  saveFeedback: vi.fn(),
  searchPapers: vi.fn(),
  signFeedback: vi.fn(),
  verifyFeedback: vi.fn(),
  verifyFeedbackToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({ requireOwner: mocks.requireOwner }));
vi.mock("../../lib/auth-session", () => ({ requireOwner: mocks.requireOwner }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: mocks.redirect,
}));
vi.mock("@/lib/data", () => ({
  addAnnotation: mocks.addAnnotation,
  deleteAnnotation: mocks.deleteAnnotation,
  getAnnotations: mocks.getAnnotations,
  getChats: mocks.getChats,
  getPaper: mocks.getPaper,
  getTop5: mocks.getTop5,
  listArchive: mocks.listArchive,
  saveChat: mocks.saveChat,
  saveFeedback: mocks.saveFeedback,
  redeemFeedbackToken: mocks.redeemFeedbackToken,
  searchPapers: mocks.searchPapers,
}));
vi.mock("@/lib/llm", () => ({
  CHAT_MODEL: "test-model",
  deepseek: () => ({ chat: { completions: { create: mocks.createCompletion } } }),
}));
vi.mock("@/lib/sign", () => ({
  signFeedback: mocks.signFeedback,
  verifyFeedback: mocks.verifyFeedback,
  verifyFeedbackToken: mocks.verifyFeedbackToken,
}));
vi.mock("docx", () => ({
  Document: class {},
  HeadingLevel: { HEADING_1: "h1", HEADING_2: "h2" },
  Packer: { toBuffer: mocks.packDocx },
  Paragraph: class {},
  TextRun: class {},
}));

import PrivateLayout from "../../app/(private)/layout";
import Home from "../../app/(private)/page";
import PaperPage from "../../app/(private)/paper/[id]/page";
import SearchPage from "../../app/(private)/search/page";
import { DELETE as deleteAnnotation, GET as getAnnotations, POST as addAnnotation } from "../../app/api/annotations/route";
import { GET as getChats, POST as postChat } from "../../app/api/chat/route";
import { GET as exportPaper } from "../../app/api/export/[id]/route";
import { GET as signedFeedback, POST as postFeedback } from "../../app/api/feedback/route";
import { POST as redeemFeedback } from "../../app/api/feedback/redeem/route";
import PaperList from "../../components/PaperList";
import { OwnerAuthError } from "../../lib/auth";

const itemId = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireOwner.mockRejectedValue(new OwnerAuthError("AUTH_UNAUTHENTICATED"));
  mocks.redirect.mockImplementation(() => {
    throw new Error("LOGIN_REDIRECT");
  });
  mocks.addAnnotation.mockResolvedValue({ id: itemId });
  mocks.createCompletion.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "answer" }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    },
  });
  mocks.getAnnotations.mockResolvedValue([]);
  mocks.getChats.mockResolvedValue([]);
  mocks.getPaper.mockResolvedValue({
    abstract: "abstract",
    authors: [],
    id: itemId,
    signals: {},
    source: "test",
    summary: null,
    title: "paper",
    url: "https://example.com/paper",
  });
  mocks.getTop5.mockResolvedValue({ date: "2026-07-13", papers: [] });
  mocks.listArchive.mockResolvedValue([]);
  mocks.packDocx.mockResolvedValue(Buffer.from("docx"));
  mocks.saveChat.mockResolvedValue(undefined);
  mocks.saveFeedback.mockResolvedValue(undefined);
  mocks.redeemFeedbackToken.mockResolvedValue({ ok: false, reason: "already_redeemed" });
  mocks.searchPapers.mockResolvedValue([]);
  mocks.signFeedback.mockReturnValue("token");
  mocks.verifyFeedback.mockReturnValue(true);
});

describe("private rendering entry points", () => {
  test.each([
    { code: "AUTH_UNAUTHENTICATED", message: "LOGIN_REDIRECT" },
    { code: "AUTH_FORBIDDEN", message: "LOGIN_REDIRECT" },
    { code: "AUTH_UNAVAILABLE", message: "Authentication unavailable" },
  ] as const)("stop every service-role read for $code", async ({ code, message }) => {
    mocks.requireOwner.mockRejectedValue(new OwnerAuthError(code));
    const operations = [
      () => PrivateLayout({ children: <p>private</p> }),
      () => Home(),
      () => PaperPage({ params: Promise.resolve({ id: itemId }) }),
      () => SearchPage({ searchParams: Promise.resolve({ q: "RAG" }) }),
      () => PaperList(),
    ];

    for (const operation of operations) {
      await expect(Promise.resolve().then(operation)).rejects.toThrow(message);
    }

    expect(mocks.requireOwner).toHaveBeenCalledTimes(operations.length);
    expect(mocks.getTop5).not.toHaveBeenCalled();
    expect(mocks.getPaper).not.toHaveBeenCalled();
    expect(mocks.getAnnotations).not.toHaveBeenCalled();
    expect(mocks.searchPapers).not.toHaveBeenCalled();
    expect(mocks.listArchive).not.toHaveBeenCalled();
  });
});

describe("business API entry points", () => {
  test.each([
    { body: "Authentication required", code: "AUTH_UNAUTHENTICATED", status: 401 },
    { body: "Access forbidden", code: "AUTH_FORBIDDEN", status: 403 },
    { body: "Authentication unavailable", code: "AUTH_UNAVAILABLE", status: 503 },
  ] as const)("returns $status before parsing or downstream work", async ({ body, code, status }) => {
    mocks.requireOwner.mockRejectedValue(new OwnerAuthError(code));
    const operations = [
      () => getAnnotations(new Request(`https://papers.example.com/api/annotations?itemId=${itemId}`)),
      () => addAnnotation(new Request("https://papers.example.com/api/annotations", { body: JSON.stringify({ itemId, type: "note", anchor: { x: 1, y: 1 } }), method: "POST" })),
      () => deleteAnnotation(new Request(`https://papers.example.com/api/annotations?id=${itemId}`, { method: "DELETE" })),
      () => getChats(new Request(`https://papers.example.com/api/chat?itemId=${itemId}`)),
      () => postChat(new Request("https://papers.example.com/api/chat", { body: JSON.stringify({ itemId, message: "question" }), method: "POST" })),
      () => signedFeedback(new Request(`https://papers.example.com/api/feedback?i=${itemId}&r=up&t=token`)),
      () => postFeedback(new Request("https://papers.example.com/api/feedback", { body: JSON.stringify({ itemId, rating: "up" }), method: "POST" })),
      () => redeemFeedback(new Request("https://papers.example.com/api/feedback/redeem", { body: JSON.stringify({ token: "hostile" }), method: "POST" })),
      () => exportPaper(new Request(`https://papers.example.com/api/export/${itemId}?format=docx`), { params: Promise.resolve({ id: itemId }) }),
    ];

    for (const operation of operations) {
      const response = await Promise.resolve().then(operation);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Expires")).toBe("0");
      expect(response.headers.get("Pragma")).toBe("no-cache");
      expect(response.headers.get("Vary")).toContain("Cookie");
      expect(response.headers.get("Vary")).toContain("Origin");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }

    expect(mocks.requireOwner).toHaveBeenCalledTimes(operations.length);
    for (const name of [
      "addAnnotation",
      "createCompletion",
      "deleteAnnotation",
      "getAnnotations",
      "getChats",
      "getPaper",
      "packDocx",
      "redeemFeedbackToken",
      "saveChat",
      "saveFeedback",
      "signFeedback",
      "verifyFeedback",
      "verifyFeedbackToken",
    ] as const) {
      expect(mocks[name], name).not.toHaveBeenCalled();
    }
  });
});
