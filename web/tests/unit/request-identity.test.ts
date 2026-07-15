import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clientIPFingerprint } from "@/lib/request-identity";

const secret = "rate-limit-secret-".padEnd(48, "s");
const production = Object.freeze({ nodeEnv: "production", vercel: "1" });

function request(ip?: string, url = "https://papers.example.com/api/chat", extra = {}) {
  return new Request(url, {
    headers: {
      ...(ip === undefined ? {} : { "x-vercel-forwarded-for": ip }),
      ...extra,
    },
  });
}

function rawIPRequest(ip: string | undefined): Request {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-vercel-forwarded-for" ? ip ?? null : null,
    },
    url: "https://papers.example.com/api/chat",
  } as Request;
}

describe("trusted client IP fingerprint", () => {
  test("uses the Vercel-overwritten single client IP and a domain-separated HMAC", () => {
    const fingerprint = clientIPFingerprint(
      request("203.0.113.7", undefined, { "x-forwarded-for": "198.51.100.9" }),
      { secret, secretVersion: 7 },
      production,
    );
    const expected = createHmac("sha256", secret)
      .update("frontier-paper-dispatch:api-ip:v1\0")
      .update("203.0.113.7")
      .digest("hex");

    expect(fingerprint).toBe(`v7:${expected}`);
    expect(fingerprint).not.toContain("203.0.113.7");
  });

  test("canonicalizes equivalent IPv6 forms before hashing", () => {
    const expanded = clientIPFingerprint(
      request("2001:0db8:0000:0000:0000:ff00:0042:8329"),
      { secret, secretVersion: 1 },
      production,
    );
    const compressed = clientIPFingerprint(
      request("2001:db8::ff00:42:8329"),
      { secret, secretVersion: 1 },
      production,
    );

    expect(expanded).toBe(compressed);
  });

  test("separates IPs, secrets, and explicit rotation versions", () => {
    const first = clientIPFingerprint(
      request("203.0.113.7"),
      { secret, secretVersion: 1 },
      production,
    );
    expect(
      clientIPFingerprint(
        request("203.0.113.8"),
        { secret, secretVersion: 1 },
        production,
      ),
    ).not.toBe(first);
    expect(
      clientIPFingerprint(
        request("203.0.113.7"),
        { secret: `${secret}x`, secretVersion: 1 },
        production,
      ),
    ).not.toBe(first);
    expect(
      clientIPFingerprint(
        request("203.0.113.7"),
        { secret, secretVersion: 2 },
        production,
      ),
    ).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test.each([
    ["missing", undefined],
    ["comma list", "203.0.113.7, 198.51.100.9"],
    ["leading whitespace", " 203.0.113.7"],
    ["trailing whitespace", "203.0.113.7 "],
    ["port", "203.0.113.7:443"],
    ["bracketed IPv6", "[2001:db8::1]"],
    ["IPv6 zone", "fe80::1%en0"],
    ["control character", "203.0.113.7\t"],
    ["hostname", "client.example.com"],
  ])("rejects a %s platform IP instead of sharing or trusting it", (_name, ip) => {
    expect(() =>
      clientIPFingerprint(
        rawIPRequest(ip),
        { secret, secretVersion: 1 },
        production,
      ),
    ).toThrow("CLIENT_IP_UNAVAILABLE");
  });

  test("fails closed in non-Vercel production instead of trusting proxy headers", () => {
    expect(() =>
      clientIPFingerprint(
        request("203.0.113.7", undefined, { "x-real-ip": "203.0.113.7" }),
        { secret, secretVersion: 1 },
        { nodeEnv: "production", vercel: undefined },
      ),
    ).toThrow("CLIENT_IP_UNAVAILABLE");
  });

  test("uses only a synthetic loopback identity during loopback development", () => {
    const local = clientIPFingerprint(
      request("203.0.113.7", "http://127.0.0.1:3000/api/chat", {
        "x-real-ip": "198.51.100.9",
      }),
      { secret, secretVersion: 1 },
      { nodeEnv: "development", vercel: undefined },
    );
    const withoutHeaders = clientIPFingerprint(
      request(undefined, "http://127.0.0.1:3000/api/chat"),
      { secret, secretVersion: 1 },
      { nodeEnv: "development", vercel: undefined },
    );

    expect(local).toBe(withoutHeaders);
  });

  test("does not enable the local fallback on a non-loopback development host", () => {
    expect(() =>
      clientIPFingerprint(
        request(undefined, "https://dev.example.com/api/chat"),
        { secret, secretVersion: 1 },
        { nodeEnv: "development", vercel: undefined },
      ),
    ).toThrow("CLIENT_IP_UNAVAILABLE");
  });

  test.each([
    [{ secret: "short", secretVersion: 1 }, "short secret"],
    [{ secret, secretVersion: 0 }, "zero version"],
    [{ secret, secretVersion: 1.5 }, "fractional version"],
    [{ secret, secretVersion: 1_000_000 }, "oversized version"],
  ])("rejects invalid fingerprint configuration: %s", (config) => {
    expect(() => clientIPFingerprint(request("203.0.113.7"), config, production)).toThrow(
      "CLIENT_IP_UNAVAILABLE",
    );
  });
});
