import {
  chmodSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "./runtime-config.ts";
import {
  assertFileUnchanged,
  readSecureFile,
  repairFileMode,
  snapshotFileMode,
  writeSecureFileExclusive,
  type SecureFileSnapshot,
} from "./secure-file.ts";

interface EnvEntry {
  decoded: string;
  raw: string;
}

export interface EnvMigrationOptions {
  clock?: () => Date;
}

export interface EnvMigrationResult {
  backupPath?: string;
  changed: boolean;
  migratedKeys: readonly string[];
  permissionsFixed: boolean;
}

function entriesFromText(text: string): Map<string, EnvEntry> {
  return new Map(
    Object.entries(parseEnvText(text)).map(([key, decoded]) => [
      key,
      { decoded, raw: JSON.stringify(decoded) },
    ]),
  );
}

export function parseEnvText(text: string): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  } catch {
    throw new ConfigError([{ code: "INVALID", key: ".env syntax" }]);
  }
}

function deepSeekLegacyAllowed(entries: ReadonlyMap<string, EnvEntry>): boolean {
  if (entries.get("LLM_PROVIDER")?.decoded.toLowerCase() !== "deepseek") return false;
  const rawURL = entries.get("LLM_BASE_URL")?.decoded;
  if (!rawURL) return false;
  try {
    const url = new URL(rawURL);
    return url.protocol === "https:" &&
      (url.hostname === "deepseek.com" || url.hostname.endsWith(".deepseek.com"));
  } catch {
    return false;
  }
}

function backupName(path: string, instant: Date): string {
  const timestamp = instant
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
  return join(dirname(path), `${basename(path)}.migrated.${timestamp}.bak`);
}

function createBackup(path: string, content: string, instant: Date): string {
  const base = backupName(path, instant).replace(/\.bak$/, "");
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = `${base}${suffix ? `.${suffix}` : ""}.bak`;
    try {
      writeSecureFileExclusive(candidate, content);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new ConfigError([{ code: "INVALID", key: ".env backup" }]);
}

export function migrateEnvFile(
  path: string,
  options: EnvMigrationOptions = {},
): EnvMigrationResult {
  const snapshot = readSecureFile(path, { key: ".env", required: true }) as SecureFileSnapshot;
  const original = snapshot.text;
  const permissionsFixed = snapshotFileMode(snapshot) !== 0o600;
  const entries = entriesFromText(original);
  const aliases = [
    {
      allowed: deepSeekLegacyAllowed(entries),
      canonical: "DEEPSEEK_API_KEY",
      legacy: "LLM_API_KEY",
    },
    {
      allowed: true,
      canonical: "SERVERCHAN_SENDKEY",
      legacy: "SERVERCHAN_KEY",
    },
    {
      allowed: true,
      canonical: "SMTP_PASS",
      legacy: "SMTP_PASSWORD",
    },
    {
      allowed: true,
      canonical: "SMTP_SECURE",
      legacy: "SMTP_USE_SSL",
    },
  ] as const;
  const additions: string[] = [];
  const migratedKeys: string[] = [];

  for (const alias of aliases) {
    if (!alias.allowed) continue;
    const legacy = entries.get(alias.legacy);
    if (!legacy?.decoded) continue;
    const migratedValue = alias.canonical === "SMTP_SECURE"
      ? ({ "0": "false", "1": "true", false: "false", true: "true" } as const)[legacy.decoded.toLowerCase() as "0" | "1" | "false" | "true"]
      : legacy.decoded;
    if (migratedValue === undefined) {
      throw new ConfigError([{ code: "INVALID", key: alias.legacy }]);
    }
    const canonical = entries.get(alias.canonical);
    if (canonical && canonical.decoded !== migratedValue) {
      throw new ConfigError([
        { code: "CONFLICT", key: alias.canonical, relatedKey: alias.legacy },
      ]);
    }
    if (canonical) continue;
    additions.push(`${alias.canonical}=${JSON.stringify(migratedValue)}`);
    migratedKeys.push(alias.canonical);
  }

  if (!additions.length) {
    if (permissionsFixed) repairFileMode(path, snapshot);
    return Object.freeze({
      changed: permissionsFixed,
      migratedKeys: Object.freeze([]),
      permissionsFixed,
    });
  }

  assertFileUnchanged(path, snapshot);
  const backupPath = createBackup(path, original, (options.clock ?? (() => new Date()))());

  const separator = original.endsWith("\n") ? "" : "\n";
  const migrated = `${original}${separator}\n# ---- Frontier canonical aliases (migrated; legacy keys retained) ----\n${additions.join("\n")}\n`;
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, migrated, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    try {
      assertFileUnchanged(path, snapshot);
    } catch (error) {
      rmSync(backupPath, { force: true });
      throw error;
    }
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return Object.freeze({
    backupPath,
    changed: true,
    migratedKeys: Object.freeze([...migratedKeys]),
    permissionsFixed,
  });
}
