import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { ConfigError } from "./runtime-config.ts";

interface FileFingerprint {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  size: bigint;
}

export interface SecureFileSnapshot {
  readonly fingerprint: FileFingerprint;
  readonly text: string;
}

interface SecureFileOptions {
  expectedMode?: number;
  key?: string;
  required?: boolean;
}

function fingerprint(stat: BigIntStats): FileFingerprint {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof FileFingerprint] === right[key as keyof FileFingerprint],
  );
}

function validateStat(stat: BigIntStats, key: string, expectedMode?: number): void {
  if (!stat.isFile()) throw new ConfigError([{ code: "INVALID", key }]);
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    throw new ConfigError([{ code: "INVALID", key: `${key} owner` }]);
  }
  if (expectedMode !== undefined && Number(stat.mode & 0o777n) !== expectedMode) {
    throw new ConfigError([{ code: "INVALID", key: `${key} mode` }]);
  }
}

export function readSecureFile(
  path: string,
  options: SecureFileOptions = {},
): SecureFileSnapshot | undefined {
  const key = options.key ?? ".env";
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError([
      { code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "INVALID", key },
    ]);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    validateStat(before, key, options.expectedMode);
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFingerprint(fingerprint(before), fingerprint(after))) {
      throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-during-read" }]);
    }
    return Object.freeze({ fingerprint: Object.freeze(fingerprint(after)), text });
  } finally {
    closeSync(descriptor);
  }
}

export function assertFileUnchanged(
  path: string,
  snapshot: SecureFileSnapshot,
  key = ".env",
): void {
  let current: BigIntStats;
  try {
    current = lstatSync(path, { bigint: true });
  } catch {
    throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-after-read" }]);
  }
  if (current.isSymbolicLink() || !sameFingerprint(snapshot.fingerprint, fingerprint(current))) {
    throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-after-read" }]);
  }
}

export function snapshotFileMode(snapshot: SecureFileSnapshot): number {
  return Number(snapshot.fingerprint.mode & 0o777n);
}

export function repairFileMode(
  path: string,
  snapshot: SecureFileSnapshot,
  mode = 0o600,
  key = ".env",
): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-after-read" }]);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFingerprint(snapshot.fingerprint, fingerprint(before))) {
      throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-after-read" }]);
    }
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    after.dev !== snapshot.fingerprint.dev ||
    after.ino !== snapshot.fingerprint.ino ||
    Number(after.mode & 0o777n) !== mode
  ) {
    throw new ConfigError([{ code: "CONFLICT", key, relatedKey: "changed-after-read" }]);
  }
}

export function writeSecureFileExclusive(path: string, text: string): void {
  writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
