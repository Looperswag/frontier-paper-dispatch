import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runPreflight } from "../../lib/preflight.ts";

const temporaryDirectories: string[] = [];
const rootValues = {
  DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
  FEEDBACK_SECRET: "f".repeat(40),
  SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
  WEB_BASE_URL: "https://papers.example.com",
};

function envText(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "frontier-preflight-"));
  temporaryDirectories.push(path);
  return path;
}

function envFile(path: string, values: Record<string, string>, mode = 0o600): string {
  writeFileSync(path, envText(values), { mode });
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("runPreflight", () => {
  test("validates a mode-0600 ingest file before external work", () => {
    const root = directory();
    const path = envFile(join(root, ".env"), rootValues);

    expect(runPreflight({ rootEnvPath: path, target: "ingest" })).toMatchObject({
      checkedFiles: [path],
      status: "ok",
      target: "ingest",
    });
  });

  test.each([0o644, 0o640, 0o666])("rejects an environment file with mode %o", (mode) => {
    const root = directory();
    const path = envFile(join(root, ".env"), rootValues);
    chmodSync(path, mode);

    expect(() => runPreflight({ rootEnvPath: path, target: "ingest" })).toThrow(/mode|\.env/);
  });

  test("rejects missing, symlinked, and non-file configuration", () => {
    const root = directory();
    const target = envFile(join(root, "real.env"), rootValues);
    const link = join(root, ".env");
    symlinkSync(target, link);

    expect(() => runPreflight({ rootEnvPath: link, target: "ingest" })).toThrow(/\.env/);
    expect(() =>
      runPreflight({ rootEnvPath: join(root, "missing.env"), target: "ingest" }),
    ).toThrow(/\.env/);
    expect(() => runPreflight({ rootEnvPath: root, target: "ingest" })).toThrow(/\.env/);
  });

  test("allows dry preflight without any environment file", () => {
    const root = directory();
    expect(
      runPreflight({ rootEnvPath: join(root, "missing.env"), target: "dry" }),
    ).toMatchObject({ checkedFiles: [], status: "ok" });
  });

  test("reports invalid keys without printing environment values", () => {
    const root = directory();
    const sentinel = "sentinel-secret-never-print";
    const path = envFile(join(root, ".env"), {
      DEEPSEEK_API_KEY: sentinel,
      SUPABASE_SERVICE_ROLE_KEY: sentinel,
      SUPABASE_URL: `https://${sentinel}@example.com`,
    });

    const error = (() => {
      try {
        runPreflight({ rootEnvPath: path, target: "ingest" });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(String(error) + JSON.stringify(error)).not.toContain(sentinel);
  });

  test("all detects root/Web project and feedback mismatches without values", () => {
    const root = directory();
    const rootPath = envFile(join(root, ".env"), rootValues);
    const webPath = envFile(join(root, "web.env"), {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: rootValues.DEEPSEEK_API_KEY,
      FEEDBACK_SECRET: "z".repeat(40),
      RATE_LIMIT_SECRET: "r".repeat(40),
      RATE_LIMIT_SECRET_VERSION: "1",
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"q".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://different.supabase.co",
      WEB_BASE_URL: rootValues.WEB_BASE_URL,
    });

    const error = (() => {
      try {
        runPreflight({ rootEnvPath: rootPath, target: "all", webEnvPath: webPath });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    const rendered = String(error) + JSON.stringify(error);
    expect(rendered).toMatch(/SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
    expect(rendered).toContain("FEEDBACK_SECRET");
    expect(rendered).not.toContain("different.supabase.co");
    expect(rendered).not.toContain("sb_secret_");
  });

  test("identifies a missing Web environment separately from the Root environment", () => {
    const root = directory();
    const rootPath = envFile(join(root, ".env"), rootValues);

    expect(() =>
      runPreflight({
        rootEnvPath: rootPath,
        target: "all",
        webEnvPath: join(root, "missing-web.env"),
      }),
    ).toThrow("MISSING:web/.env.local");
  });

  test("validates a mode-0600 local Web development file", () => {
    const root = directory();
    const webPath = envFile(join(root, ".env.local"), {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: rootValues.DEEPSEEK_API_KEY,
      FEEDBACK_SECRET: rootValues.FEEDBACK_SECRET,
      RATE_LIMIT_SECRET: "r".repeat(40),
      RATE_LIMIT_SECRET_VERSION: "1",
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: rootValues.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_URL: "http://127.0.0.1:54321",
      WEB_BASE_URL: "http://127.0.0.1:3000",
    });

    expect(runPreflight({ target: "web:development", webEnvPath: webPath })).toMatchObject({
      checkedFiles: [webPath],
      status: "ok",
    });
  });

  test("requires the feedback capability before Web development starts", () => {
    const root = directory();
    const webPath = envFile(join(root, ".env.local"), {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: rootValues.DEEPSEEK_API_KEY,
      RATE_LIMIT_SECRET: "r".repeat(40),
      RATE_LIMIT_SECRET_VERSION: "1",
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: rootValues.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_URL: "http://127.0.0.1:54321",
    });

    expect(() => runPreflight({ target: "web:development", webEnvPath: webPath })).toThrow(
      /FEEDBACK_SECRET|WEB_BASE_URL/,
    );
  });

  test("requires the distributed quota capability before Web development starts", () => {
    const root = directory();
    const webPath = envFile(join(root, ".env.local"), {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: rootValues.DEEPSEEK_API_KEY,
      FEEDBACK_SECRET: rootValues.FEEDBACK_SECRET,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: rootValues.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_URL: "http://127.0.0.1:54321",
      WEB_BASE_URL: "http://127.0.0.1:3000",
    });

    expect(() => runPreflight({ target: "web:development", webEnvPath: webPath })).toThrow(
      /RATE_LIMIT_SECRET|RATE_LIMIT_SECRET_VERSION/,
    );
  });

  test("rejects an obsolete demo switch before Web development starts", () => {
    const root = directory();
    const webPath = envFile(join(root, ".env.local"), {
      NEXT_PUBLIC_DEMO_MODE: "1",
      SUPABASE_SERVICE_ROLE_KEY: rootValues.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_URL: "http://127.0.0.1:54321",
    });

    expect(() => runPreflight({ target: "web:development", webEnvPath: webPath })).toThrow(
      "OBSOLETE:NEXT_PUBLIC_DEMO_MODE",
    );
  });
});
