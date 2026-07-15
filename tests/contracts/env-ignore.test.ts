import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("environment-file ignore contract", () => {
  test("ignores secret backups while keeping examples versioned", () => {
    const rootIgnore = readFileSync(".gitignore", "utf8");
    const webIgnore = readFileSync("web/.gitignore", "utf8");

    expect(rootIgnore).toMatch(/^\.env\.\*/m);
    expect(rootIgnore).toMatch(/^!\.env\.example$/m);
    expect(webIgnore).toMatch(/^\.env\*$/m);
    expect(webIgnore).toMatch(/^!\.env\.example$/m);
  });
});
