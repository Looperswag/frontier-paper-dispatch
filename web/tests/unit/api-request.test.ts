import { describe, expect, test } from "vitest";
import {
  exactQuery,
  hasSameMutationOrigin,
  readBoundedJSON,
} from "@/lib/api-request";

function jsonRequest(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("https://papers.example.com/api/private", {
    body,
    duplex: "half",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://papers.example.com",
      ...headers,
    },
    method: "POST",
    signal,
  } as RequestInit & { duplex: "half" });
}

describe("shared private API request boundary", () => {
  test("accepts only the exact external Origin", () => {
    expect(hasSameMutationOrigin(jsonRequest("{}"))).toBe(true);
    expect(
      hasSameMutationOrigin(
        jsonRequest("{}", {
          Host: "papers.example.com",
          "X-Forwarded-Host": "attacker.example",
          "X-Forwarded-Proto": "https",
        }),
      ),
    ).toBe(true);
    const rejectedHeaders: Array<Record<string, string>> = [
      { Origin: "null" },
      { Origin: "https://attacker.example" },
      { Host: "attacker.example" },
      { Host: "papers.example.com, attacker.example" },
      { Host: "papers.example.com?ignored=attacker" },
      { Host: "papers.example.com#attacker" },
      { "X-Forwarded-Proto": "ftp" },
      { "X-Forwarded-Proto": "https,http" },
    ];
    for (const headers of rejectedHeaders) {
      expect(hasSameMutationOrigin(jsonRequest("{}", headers))).toBe(false);
    }
  });

  test("allows only one occurrence of each known query parameter", () => {
    expect(
      exactQuery(new Request("https://papers.example.com/api/x?id=one"), ["id"]),
    ).toEqual({ id: "one" });
    expect(
      exactQuery(new Request("https://papers.example.com/api/x?id=one&id=two"), ["id"]),
    ).toBeUndefined();
    expect(
      exactQuery(new Request("https://papers.example.com/api/x?id=one&extra=two"), ["id"]),
    ).toBeUndefined();
  });

  test.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["application/json; charset=\"utf-8\"", true],
    ["text/plain", false],
    ["application/json; charset=latin1", false],
    ["application/json; charset=utf-8; profile=x", false],
  ])("validates JSON media type %s", async (contentType, accepted) => {
    const result = await readBoundedJSON(
      jsonRequest("{}", { "Content-Type": contentType }),
      { maxBytes: 100 },
    );
    expect(result.ok).toBe(accepted);
    if (!accepted && !result.ok) expect(result.reason).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test.each(["abc", "-1", "100000000000"])(
    "rejects malformed declared length %s before JSON parsing",
    async (length) => {
      const result = await readBoundedJSON(
        jsonRequest("{}", { "Content-Length": length }),
        { maxBytes: 100 },
      );
      expect(result).toEqual({ ok: false, reason: "PAYLOAD_TOO_LARGE" });
    },
  );

  test("rejects invalid UTF-8 and excessive JSON depth", async () => {
    const invalidUTF8 = await readBoundedJSON(
      jsonRequest(new Uint8Array([0xc3, 0x28])),
      { maxBytes: 100 },
    );
    expect(invalidUTF8).toEqual({ ok: false, reason: "INVALID_REQUEST" });

    const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: 1 } } } } } });
    await expect(readBoundedJSON(jsonRequest(deep), { maxBytes: 100 })).resolves.toEqual({
      ok: false,
      reason: "INVALID_REQUEST",
    });

    const tooManyNodes = JSON.stringify(Array.from({ length: 4_097 }, () => 0));
    await expect(
      readBoundedJSON(jsonRequest(tooManyNodes), { maxBytes: 10_000 }),
    ).resolves.toEqual({ ok: false, reason: "INVALID_REQUEST" });
  });

  test("does not wait for a hostile cancel promise after exceeding the byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
      pull(controller) {
        controller.enqueue(new Uint8Array(80));
      },
    });
    const result = await Promise.race([
      readBoundedJSON(jsonRequest(stream), { maxBytes: 100 }),
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 50)),
    ]);

    expect(result).toEqual({ ok: false, reason: "PAYLOAD_TOO_LARGE" });
  });

  test("a caller abort releases a pending body read", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    });
    const pending = readBoundedJSON(jsonRequest(stream, {}, controller.signal), {
      maxBytes: 100,
    });
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 50)),
    ]);

    expect(result).toEqual({ ok: false, reason: "INVALID_REQUEST" });
  });
});
