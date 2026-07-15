import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigError } from "../../lib/runtime-config.ts";
import { migrateEnvFile, parseEnvText } from "../../lib/env-migration.ts";
import { parseEnv } from "node:util";

const temporaryDirectories: string[] = [];
const llmSecret = `sk-${"l".repeat(40)}`;
const serverSecret = `SCT${"w".repeat(40)}`;

function fixture(content: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "frontier-env-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env");
  writeFileSync(path, content, { mode });
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("migrateEnvFile", () => {
  test.each([
    ["unquoted comment", "KEY=value # comment\n"],
    ["export prefix", "export KEY=value\n"],
    ["quoted multiline", 'KEY="line one\nline two"\n'],
    ["quoted hash", 'KEY="value#inside"\n'],
  ])("uses Node dotenv semantics for %s", (_name, content) => {
    expect(parseEnvText(content)).toEqual({ ...parseEnv(content) });
  });

  test("migrates safe provider aliases and never guesses a Supabase URL from DB_URL", () => {
    const path = fixture(
      [
        "LLM_PROVIDER=deepseek",
        "LLM_BASE_URL=https://api.deepseek.com/v1",
        `LLM_API_KEY=${llmSecret}`,
        `SERVERCHAN_KEY=${serverSecret}`,
        "SMTP_PASSWORD=mail-app-password",
        "SMTP_USE_SSL=true",
        "DB_URL=postgresql:///private/legacy.db",
        "",
      ].join("\n"),
    );

    const result = migrateEnvFile(path, {
      clock: () => new Date("2026-07-10T01:02:03.000Z"),
    });
    const parsed = parseEnvText(readFileSync(path, "utf8"));

    expect(result).toMatchObject({
      changed: true,
      migratedKeys: ["DEEPSEEK_API_KEY", "SERVERCHAN_SENDKEY", "SMTP_PASS", "SMTP_SECURE"],
    });
    expect(parsed.DEEPSEEK_API_KEY).toBe(llmSecret);
    expect(parsed.SERVERCHAN_SENDKEY).toBe(serverSecret);
    expect(parsed.SMTP_PASS).toBe("mail-app-password");
    expect(parsed.SMTP_SECURE).toBe("true");
    expect(parsed.SUPABASE_URL).toBeUndefined();
    expect(parsed.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("DB_URL=postgresql:///private/legacy.db");
  });

  test("does not migrate an LLM key for a non-DeepSeek provider", () => {
    const path = fixture(
      [
        "LLM_PROVIDER=other",
        "LLM_BASE_URL=https://api.other.example/v1",
        `LLM_API_KEY=${llmSecret}`,
        "",
      ].join("\n"),
    );

    const result = migrateEnvFile(path);

    expect(result.changed).toBe(false);
    expect(parseEnvText(readFileSync(path, "utf8")).DEEPSEEK_API_KEY).toBeUndefined();
  });

  test("normalizes legacy SMTP booleans to the canonical strict value", () => {
    const path = fixture("SMTP_USE_SSL=1\n");

    migrateEnvFile(path);

    expect(parseEnvText(readFileSync(path, "utf8")).SMTP_SECURE).toBe("true");
  });

  test("repairs an unsafe mode even when aliases are already canonical", () => {
    const path = fixture(`SERVERCHAN_SENDKEY=${serverSecret}\n`, 0o640);

    const result = migrateEnvFile(path);

    expect(result).toMatchObject({ changed: true, migratedKeys: [], permissionsFixed: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result.backupPath).toBeUndefined();
  });

  test("never overwrites a canonical value and safely rejects a conflict", () => {
    const canonical = `SCT${"a".repeat(40)}`;
    const legacy = `SCT${"b".repeat(40)}`;
    const path = fixture(`SERVERCHAN_SENDKEY=${canonical}\nSERVERCHAN_KEY=${legacy}\n`);

    const error = (() => {
      try {
        migrateEnvFile(path);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("SERVERCHAN_SENDKEY");
    expect(String(error)).toContain("SERVERCHAN_KEY");
    expect(String(error)).not.toContain(canonical);
    expect(String(error)).not.toContain(legacy);
    expect(readFileSync(path, "utf8")).toBe(
      `SERVERCHAN_SENDKEY=${canonical}\nSERVERCHAN_KEY=${legacy}\n`,
    );
  });

  test("is idempotent and creates one mode-0600 backup only when changing", () => {
    const path = fixture(`SERVERCHAN_KEY='${serverSecret}'\n`, 0o640);
    const clock = () => new Date("2026-07-10T01:02:03.000Z");

    const first = migrateEnvFile(path, { clock });
    const afterFirst = readFileSync(path, "utf8");
    const second = migrateEnvFile(path, { clock });

    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(first.backupPath as string).mode & 0o777).toBe(0o600);
    expect(second).toMatchObject({ changed: false, migratedKeys: [] });
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });

  test("never overwrites an existing backup with the same timestamp", () => {
    const path = fixture(`SERVERCHAN_KEY=${serverSecret}\n`);
    const existing = `${path}.migrated.20260710T010203Z.bak`;
    writeFileSync(existing, "existing-backup", { mode: 0o600 });

    const result = migrateEnvFile(path, {
      clock: () => new Date("2026-07-10T01:02:03.000Z"),
    });

    expect(readFileSync(existing, "utf8")).toBe("existing-backup");
    expect(result.backupPath).not.toBe(existing);
    expect(readFileSync(result.backupPath as string, "utf8")).toContain("SERVERCHAN_KEY");
  });

  test("preserves quoted and inline-comment values without exposing them in metadata", () => {
    const path = fixture(
      `SERVERCHAN_KEY="${serverSecret}" # private\nUNRELATED='keep # exactly'\n`,
    );

    const result = migrateEnvFile(path);
    const rendered = JSON.stringify(result);

    expect(parseEnvText(readFileSync(path, "utf8"))).toMatchObject({
      SERVERCHAN_SENDKEY: serverSecret,
      UNRELATED: "keep # exactly",
    });
    expect(rendered).not.toContain(serverSecret);
  });
});
