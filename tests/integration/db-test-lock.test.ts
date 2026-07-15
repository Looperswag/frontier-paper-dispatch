import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("database test process lock", () => {
  test("disables Supabase CLI telemetry before running the database gate", () => {
    const source = readFileSync(resolve("scripts/test-db.sh"), "utf8");

    expect(source).toMatch(
      /^#!\/usr\/bin\/env bash\nset -euo pipefail\nexport SUPABASE_TELEMETRY_DISABLED=1\n/,
    );
  });

  test("cleans database race fixtures even when a background session fails", () => {
    const source = readFileSync(resolve("scripts/test-db.sh"), "utf8");

    expect(source).toMatch(
      /cleanup\(\)[\s\S]*cleanup_feedback_redemption_race[\s\S]*rm -rf "\$CONCURRENCY_DIR"/,
    );
    expect(source).toMatch(/wait "\$first_pid" \|\| first_status=\$\?/);
    expect(source).toMatch(/wait "\$second_pid" \|\| second_status=\$\?/);
  });

  test("refuses a concurrent runner before it can touch Docker", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "frontier-db-lock-"));
    temporaryDirectories.push(temporaryDirectory);
    const lockDirectory = join(
      temporaryDirectory,
      "supabase_db_frontier-paper-dispatch.test.lock",
    );
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });

    const result = spawnSync("bash", [resolve("scripts/test-db.sh")], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temporaryDirectory },
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/database test is already running/i);
    expect(result.stdout).not.toMatch(/starting database|resetting local database/i);
  });
});
