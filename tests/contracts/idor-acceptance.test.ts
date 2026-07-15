import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function text(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("real dual-identity IDOR acceptance wiring", () => {
  test("exposes one root gate and one isolated real-Playwright gate", () => {
    const rootPackage = JSON.parse(text("package.json")) as {
      scripts?: Record<string, string>;
    };
    const webPackage = JSON.parse(text("web/package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(rootPackage.scripts?.["test:idor"]).toBe("bash scripts/test-idor.sh");
    expect(webPackage.scripts?.["test:e2e:idor"]).toBe(
      "playwright test --config playwright.idor.config.ts",
    );
  });

  test("keeps destructive local setup locked, explicit, and self-cleaning", () => {
    const runner = text("scripts/test-idor.sh");

    expect(runner).toMatch(
      /^#!\/usr\/bin\/env bash\nset -euo pipefail\nexport SUPABASE_TELEMETRY_DISABLED=1\n/,
    );
    expect(runner).toContain("${DB_CONTAINER}.test.lock");
    expect(runner).toMatch(/Refusing to reset an existing local Supabase instance/);
    expect(runner).toMatch(/ALLOW_LOCAL_DB_RESET/);
    expect(runner).toMatch(/trap cleanup EXIT/);
    expect(runner).not.toMatch(/set -x|status -o (?:env|pretty)/);
  });

  test("runs the real authorization gate in CI with Auth signup still disabled", () => {
    expect(text(".github/workflows/ci.yml")).toMatch(
      /\n {2}authorization:\n[\s\S]*?npm run test:idor/,
    );
    const supabaseConfig = text("supabase/config.toml");
    expect(supabaseConfig).toMatch(/\[auth\][\s\S]*?enable_signup\s*=\s*false/);
    expect(supabaseConfig).toMatch(/\[auth\.email\][\s\S]*?enable_signup\s*=\s*false/);
  });
});
