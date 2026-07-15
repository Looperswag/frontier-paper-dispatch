import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("local unauthenticated development boundary", () => {
  test("binds Next development to IPv4 loopback rather than every interface", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, unknown>;
    };

    expect(packageJson.scripts?.dev).toBe("next dev --hostname 127.0.0.1");
  });
});
