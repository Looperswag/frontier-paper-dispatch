import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateFetch } from "@/lib/private-fetch";

const fetchMock = vi.fn<typeof fetch>();
const replace = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { replace });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("privateFetch", () => {
  test("returns a successful response without navigating or retrying", async () => {
    const response = Response.json({ ok: true });
    fetchMock.mockResolvedValueOnce(response);

    await expect(privateFetch("/api/private")).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  test("all private client API calls use the helper while login stays public", () => {
    const privateClients = [
      ["ChatPanel.tsx", 2],
      ["FeedbackButtons.tsx", 1],
      ["AnnotatedReader.tsx", 2],
    ] as const;
    for (const [file, expectedCalls] of privateClients) {
      const source = readFileSync(resolve(process.cwd(), "components", file), "utf8");
      expect(source).toContain('from "@/lib/private-fetch"');
      expect(source.match(/\bprivateFetch\(/g)).toHaveLength(expectedCalls);
      expect(source).not.toMatch(/\bfetch\(/);
    }

    const loginSource = readFileSync(resolve(process.cwd(), "components/LoginForm.tsx"), "utf8");
    expect(loginSource).toMatch(/\bfetch\(/);
    expect(loginSource).not.toContain("private-fetch");
  });

  test("hard-navigates to login exactly once after a 401 and never retries", async () => {
    const response = new Response("Authentication required", { status: 401 });
    fetchMock.mockResolvedValueOnce(response);

    await expect(privateFetch("/api/private", { method: "POST" })).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");
  });

  test("does not redirect for authorization, service, or network failures", async () => {
    for (const status of [403, 503]) {
      fetchMock.mockResolvedValueOnce(new Response("failure", { status }));
      await privateFetch("/api/private");
    }
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(privateFetch("/api/private")).rejects.toThrow("offline");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(replace).not.toHaveBeenCalled();
  });
});
