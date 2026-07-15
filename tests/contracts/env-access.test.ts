import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SENSITIVE =
  /process\.env(?:\.|\s*\[\s*["'])(?:APP_PASSWORD|AUTH_OWNER_EMAIL|DEEPSEEK_API_KEY|FEEDBACK_SECRET|GITHUB_TOKEN|RATE_LIMIT_SECRET(?:_VERSION)?|SERVERCHAN_(?:KEY|SENDKEY)|SUPABASE_(?:PUBLISHABLE_KEY|SERVICE_ROLE_KEY|URL)|WEB_BASE_URL)/;
const SERVER_IMPORT = /(?:from\s+|import\s*\()["'][^"']*(?:config\.server|\/data|\/llm|\/sign)["']/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".next", "coverage", "node_modules", "test-results", "tests"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("typed environment access boundary", () => {
  test("keeps sensitive process.env reads inside typed configuration modules", () => {
    const violations = [
      ...sourceFiles("lib"),
      ...sourceFiles("scripts"),
      ...sourceFiles("web/app"),
      ...sourceFiles("web/components"),
      ...sourceFiles("web/lib"),
      "web/proxy.ts",
    ]
      .filter((path) => SENSITIVE.test(readFileSync(path, "utf8")))
      .map((path) => relative(".", path));

    expect(violations).toEqual([]);
  });

  test("prevents Client Components from importing server-only modules", () => {
    const clientViolations = [...sourceFiles("web/app"), ...sourceFiles("web/components")]
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return /^\s*["']use client["'];/m.test(source) && SERVER_IMPORT.test(source);
      })
      .map((path) => relative(".", path));

    expect(clientViolations).toEqual([]);
  });

  test("root commands do not let Node read .env before secure validation", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["ingest", "ingest:send", "push:last", "refine", "refine:apply"]) {
      expect(packageJson.scripts[name]).not.toContain("--env-file");
    }
  });
});
