import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertFileUnchanged,
  readSecureFile,
  snapshotFileMode,
  writeSecureFileExclusive,
  type SecureFileSnapshot,
} from "./secure-file.ts";

const BACKUP_FORMAT = "frontier-paper-dispatch/state-backup";
const BACKUP_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const STATE_BACKUP_FILES = Object.freeze([
  "config/profile.md",
  "config/sources.ts",
] as const);

type BackupPath = (typeof STATE_BACKUP_FILES)[number];

interface BackupFile {
  readonly bytes: number;
  readonly content: string;
  readonly path: BackupPath;
  readonly sha256: string;
}

interface BackupBundle {
  readonly createdAt: string;
  readonly files: readonly BackupFile[];
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
}

export interface StateBackupReport {
  readonly destination: string;
  readonly files: readonly BackupPath[];
}

export interface StateRestoreReport {
  readonly applied: boolean;
  readonly files: readonly {
    readonly action: "create" | "overwrite";
    readonly path: BackupPath;
  }[];
}

function isOwnedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function requireDirectory(path: string, label: string, privateDirectory = false): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} directory is missing`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} directory must not be a symlink`);
  if (!stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
    throw new Error(`${label} directory is invalid`);
  }
  if (privateDirectory && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} directory permissions must be 700 or stricter`);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeClock(clock: () => Date): string {
  const instant = clock();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError("Backup clock returned an invalid date");
  }
  return instant.toISOString();
}

function defaultDestination(root: string, createdAt: string): string {
  const backupDirectory = join(root, ".backups");
  try {
    mkdirSync(backupDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  requireDirectory(backupDirectory, "backup", true);
  const timestamp = createdAt.replaceAll(":", "-");
  return join(backupDirectory, `state-${timestamp}.json`);
}

function serializeBundle(bundle: BackupBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function createStateBackup(options: Readonly<{
  clock?: () => Date;
  destination?: string;
  root?: string;
}> = {}): StateBackupReport {
  const root = resolve(options.root ?? ".");
  requireDirectory(root, "repository");
  requireDirectory(join(root, "config"), "config");
  const createdAt = safeClock(options.clock ?? (() => new Date()));
  const files = STATE_BACKUP_FILES.map((path) => {
    const snapshot = readSecureFile(join(root, path), { key: path, required: true });
    const content = snapshot!.text;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes < 1 || bytes > MAX_FILE_BYTES) {
      throw new Error(`${path} exceeds the backup size boundary`);
    }
    return Object.freeze({ bytes, content, path, sha256: sha256(content) });
  });
  const bundle: BackupBundle = Object.freeze({
    createdAt,
    files: Object.freeze(files),
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
  });
  const rendered = serializeBundle(bundle);
  if (Buffer.byteLength(rendered, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error("State backup exceeds the bundle size boundary");
  }
  const destination = resolve(options.destination ?? defaultDestination(root, createdAt));
  requireDirectory(dirname(destination), "backup destination");
  writeSecureFileExclusive(destination, rendered);
  return Object.freeze({
    destination,
    files: Object.freeze([...STATE_BACKUP_FILES]),
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Backup integrity check failed: invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function parseBundle(text: string): BackupBundle {
  if (Buffer.byteLength(text, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error("Backup integrity check failed: bundle is too large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Backup integrity check failed: invalid JSON");
  }
  const raw = objectValue(decoded, "envelope");
  if (
    raw.format !== BACKUP_FORMAT ||
    raw.version !== BACKUP_VERSION ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.files) ||
    raw.files.length !== STATE_BACKUP_FILES.length
  ) {
    throw new Error("Backup integrity check failed: unsupported envelope");
  }
  try {
    if (new Date(raw.createdAt).toISOString() !== raw.createdAt) throw new Error();
  } catch {
    throw new Error("Backup integrity check failed: invalid timestamp");
  }

  const allowed = new Set<string>(STATE_BACKUP_FILES);
  const seen = new Set<string>();
  const entries = raw.files.map((value) => {
    const file = objectValue(value, "file");
    if (typeof file.path !== "string" || !allowed.has(file.path) || seen.has(file.path)) {
      throw new Error("Backup path is outside the restore allowlist");
    }
    seen.add(file.path);
    if (
      typeof file.content !== "string" ||
      !Number.isInteger(file.bytes) ||
      (file.bytes as number) < 1 ||
      (file.bytes as number) > MAX_FILE_BYTES ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      Buffer.byteLength(file.content, "utf8") !== file.bytes ||
      sha256(file.content) !== file.sha256
    ) {
      throw new Error("Backup integrity check failed: file digest mismatch");
    }
    return Object.freeze({
      bytes: file.bytes as number,
      content: file.content,
      path: file.path as BackupPath,
      sha256: file.sha256,
    });
  });
  if (STATE_BACKUP_FILES.some((path) => !seen.has(path))) {
    throw new Error("Backup path is outside the restore allowlist");
  }
  entries.sort(
    (left, right) => STATE_BACKUP_FILES.indexOf(left.path) - STATE_BACKUP_FILES.indexOf(right.path),
  );
  return Object.freeze({
    createdAt: raw.createdAt,
    files: Object.freeze(entries),
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
  });
}

function existingTarget(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function restoreStateBackup(options: Readonly<{
  apply?: boolean;
  backupPath: string;
  force?: boolean;
  root?: string;
}>): StateRestoreReport {
  if (options.force && !options.apply) {
    throw new Error("--force requires --apply");
  }
  const root = resolve(options.root ?? ".");
  requireDirectory(root, "repository");
  const configDirectory = join(root, "config");
  requireDirectory(configDirectory, "config");
  const backup = readSecureFile(resolve(options.backupPath), {
    expectedMode: 0o600,
    key: "state backup",
    required: true,
  });
  const bundle = parseBundle(backup!.text);
  const plan = bundle.files.map((file) => {
    const target = join(root, file.path);
    const stat = existingTarget(target);
    if (stat?.isSymbolicLink()) throw new Error(`Restore target is a symlink: ${file.path}`);
    if (stat && (!stat.isFile() || !isOwnedByCurrentUser(stat))) {
      throw new Error(`Restore target is invalid: ${file.path}`);
    }
    return Object.freeze({
      action: stat ? "overwrite" as const : "create" as const,
      content: file.content,
      path: file.path,
      target,
    });
  });
  const reportFiles = Object.freeze(plan.map(({ action, path }) => Object.freeze({ action, path })));
  if (!options.apply) return Object.freeze({ applied: false, files: reportFiles });
  if (!options.force && plan.some(({ action }) => action === "overwrite")) {
    throw new Error("Restore would overwrite an existing file; review dry-run and pass --force");
  }

  type StagedRestore = (typeof plan)[number] & {
    temporaryPath: string;
    rollback?: {
      path: string;
      snapshot: SecureFileSnapshot;
    };
  };
  const staged: StagedRestore[] = [];
  try {
    for (const entry of plan) {
      const temporaryPath = join(
        dirname(entry.target),
        `.${basename(entry.target)}.${randomUUID()}.restore`,
      );
      let rollback: StagedRestore["rollback"];
      let rollbackPath: string | undefined;
      try {
        writeSecureFileExclusive(temporaryPath, entry.content);
        if (entry.action === "overwrite") {
          const snapshot = readSecureFile(entry.target, { key: entry.path, required: true });
          rollbackPath = join(
            dirname(entry.target),
            `.${basename(entry.target)}.${randomUUID()}.rollback`,
          );
          writeSecureFileExclusive(rollbackPath, snapshot!.text);
          chmodSync(rollbackPath, snapshotFileMode(snapshot!));
          rollback = Object.freeze({ path: rollbackPath, snapshot: snapshot! });
        }
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        if (rollbackPath) rmSync(rollbackPath, { force: true });
        throw error;
      }
      staged.push({ ...entry, temporaryPath, ...(rollback ? { rollback } : {}) });
    }
  } catch (error) {
    for (const entry of staged) {
      rmSync(entry.temporaryPath, { force: true });
      if (entry.rollback) rmSync(entry.rollback.path, { force: true });
    }
    throw error;
  }
  const committed: typeof staged = [];
  let preserveRollback = false;
  try {
    requireDirectory(configDirectory, "config");
    for (const entry of staged) {
      if (entry.action === "create") {
        linkSync(entry.temporaryPath, entry.target);
        committed.push(entry);
        rmSync(entry.temporaryPath);
      } else {
        if (!entry.rollback) throw new Error(`Restore rollback is missing: ${entry.path}`);
        assertFileUnchanged(entry.target, entry.rollback.snapshot, entry.path);
        renameSync(entry.temporaryPath, entry.target);
        committed.push(entry);
      }
    }
  } catch (error) {
    let rollbackIncomplete = false;
    for (const entry of committed.toReversed()) {
      try {
        if (entry.action === "create") {
          rmSync(entry.target, { force: true });
        } else if (entry.rollback) {
          renameSync(entry.rollback.path, entry.target);
        }
      } catch {
        rollbackIncomplete = true;
      }
    }
    if (rollbackIncomplete) {
      preserveRollback = true;
      throw new Error("Restore failed and rollback is incomplete; preserve .rollback files", {
        cause: error,
      });
    }
    throw error;
  } finally {
    for (const entry of staged) {
      rmSync(entry.temporaryPath, { force: true });
      if (!preserveRollback && entry.rollback) rmSync(entry.rollback.path, { force: true });
    }
  }
  return Object.freeze({ applied: true, files: reportFiles });
}
