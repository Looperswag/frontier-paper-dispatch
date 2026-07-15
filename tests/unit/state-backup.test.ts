import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createStateBackup,
  restoreStateBackup,
} from "../../lib/state-backup.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function directory(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(value);
  return value;
}

function sourceRoot(): string {
  const root = directory("frontier-state-source-");
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/profile.md"), "# Private profile\n关注 RAG。\n", { mode: 0o600 });
  writeFileSync(join(root, "config/sources.ts"), "export const sources = ['arxiv'];\n", { mode: 0o644 });
  writeFileSync(join(root, ".env"), "DEEPSEEK_API_KEY=super-secret-key\n", { mode: 0o600 });
  return root;
}

function emptyRestoreRoot(): string {
  const root = directory("frontier-state-restore-");
  mkdirSync(join(root, "config"));
  return root;
}

describe("state backup", () => {
  test("backs up only the allowlisted profile and source configuration with hashes", () => {
    const root = sourceRoot();
    const destination = join(directory("frontier-state-output-"), "state.json");

    const report = createStateBackup({
      clock: () => new Date("2026-07-15T12:34:56.000Z"),
      destination,
      root,
    });
    const text = readFileSync(destination, "utf8");
    const bundle = JSON.parse(text) as {
      createdAt: string;
      files: Array<{ bytes: number; content: string; path: string; sha256: string }>;
      format: string;
      version: number;
    };

    expect(report).toEqual({ destination, files: ["config/profile.md", "config/sources.ts"] });
    expect(bundle).toMatchObject({
      createdAt: "2026-07-15T12:34:56.000Z",
      format: "frontier-paper-dispatch/state-backup",
      version: 1,
    });
    expect(bundle.files.map((file) => file.path)).toEqual([
      "config/profile.md",
      "config/sources.ts",
    ]);
    for (const file of bundle.files) {
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
      expect(file.sha256).toBe(createHash("sha256").update(file.content).digest("hex"));
    }
    expect(text).not.toContain(".env");
    expect(text).not.toContain("super-secret-key");
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
  });

  test("never overwrites an existing backup and refuses symlinked source files", () => {
    const root = sourceRoot();
    const destination = join(directory("frontier-state-output-"), "state.json");
    writeFileSync(destination, "keep", { mode: 0o600 });

    expect(() => createStateBackup({ destination, root })).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("keep");

    const external = join(directory("frontier-state-external-"), "profile.md");
    writeFileSync(external, "outside", { mode: 0o600 });
    rmSync(join(root, "config/profile.md"));
    symlinkSync(external, join(root, "config/profile.md"));
    expect(() => createStateBackup({
      destination: join(directory("frontier-state-output-"), "other.json"),
      root,
    })).toThrow();
  });

  test("creates a private default backup directory", () => {
    const root = sourceRoot();

    const report = createStateBackup({
      clock: () => new Date("2026-07-15T12:34:56.000Z"),
      root,
    });

    expect(report.destination).toBe(
      join(root, ".backups/state-2026-07-15T12-34-56.000Z.json"),
    );
    expect(lstatSync(join(root, ".backups")).mode & 0o777).toBe(0o700);
  });

  test("rejects invalid clocks, empty state, and an exposed default backup directory", () => {
    const invalidClockRoot = sourceRoot();
    expect(() => createStateBackup({
      clock: () => new Date(Number.NaN),
      destination: join(directory("frontier-state-output-"), "state.json"),
      root: invalidClockRoot,
    })).toThrow(/clock/i);

    const emptyRoot = sourceRoot();
    writeFileSync(join(emptyRoot, "config/profile.md"), "", { mode: 0o600 });
    expect(() => createStateBackup({
      destination: join(directory("frontier-state-output-"), "state.json"),
      root: emptyRoot,
    })).toThrow(/size/i);

    const exposedRoot = sourceRoot();
    mkdirSync(join(exposedRoot, ".backups"), { mode: 0o755 });
    chmodSync(join(exposedRoot, ".backups"), 0o755);
    expect(() => createStateBackup({ root: exposedRoot })).toThrow(/permissions/i);
  });
});

describe("state restore", () => {
  function backup(): string {
    const destination = join(directory("frontier-state-output-"), "state.json");
    createStateBackup({ destination, root: sourceRoot() });
    return destination;
  }

  test("is a validation-only dry-run by default", () => {
    const backupPath = backup();
    const root = emptyRestoreRoot();

    const report = restoreStateBackup({ backupPath, root });

    expect(report).toEqual({
      applied: false,
      files: [
        { action: "create", path: "config/profile.md" },
        { action: "create", path: "config/sources.ts" },
      ],
    });
    expect(existsSync(join(root, "config/profile.md"))).toBe(false);
    expect(existsSync(join(root, "config/sources.ts"))).toBe(false);
  });

  test("applies missing files but requires force before replacing either existing file", () => {
    const backupPath = backup();
    const cleanRoot = emptyRestoreRoot();

    expect(restoreStateBackup({ apply: true, backupPath, root: cleanRoot }).applied).toBe(true);
    expect(readFileSync(join(cleanRoot, "config/profile.md"), "utf8")).toContain("Private profile");
    expect(lstatSync(join(cleanRoot, "config/profile.md")).mode & 0o777).toBe(0o600);

    const occupiedRoot = emptyRestoreRoot();
    writeFileSync(join(occupiedRoot, "config/profile.md"), "keep-profile", { mode: 0o600 });
    writeFileSync(join(occupiedRoot, "config/sources.ts"), "keep-sources", { mode: 0o600 });
    expect(() => restoreStateBackup({ apply: true, backupPath, root: occupiedRoot })).toThrow(
      /force/i,
    );
    expect(readFileSync(join(occupiedRoot, "config/profile.md"), "utf8")).toBe("keep-profile");
    expect(readFileSync(join(occupiedRoot, "config/sources.ts"), "utf8")).toBe("keep-sources");

    const report = restoreStateBackup({ apply: true, backupPath, force: true, root: occupiedRoot });
    expect(report.files.every((file) => file.action === "overwrite")).toBe(true);
    expect(readFileSync(join(occupiedRoot, "config/sources.ts"), "utf8")).toContain("arxiv");
  });

  test("rejects hash tampering before writing any file", () => {
    const backupPath = backup();
    const bundle = JSON.parse(readFileSync(backupPath, "utf8")) as {
      files: Array<{ content: string }>;
    };
    bundle.files[0].content = "tampered";
    writeFileSync(backupPath, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    const root = emptyRestoreRoot();

    expect(() => restoreStateBackup({ apply: true, backupPath, root })).toThrow(/integrity/i);
    expect(existsSync(join(root, "config/profile.md"))).toBe(false);
    expect(existsSync(join(root, "config/sources.ts"))).toBe(false);
  });

  test("rejects path substitution and a symlink target even with force", () => {
    const backupPath = backup();
    const bundle = JSON.parse(readFileSync(backupPath, "utf8")) as {
      files: Array<{ path: string }>;
    };
    bundle.files[0].path = ".env";
    writeFileSync(backupPath, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    expect(() => restoreStateBackup({ backupPath, root: emptyRestoreRoot() })).toThrow(
      /allowlist/i,
    );

    const validBackup = backup();
    const root = emptyRestoreRoot();
    const outside = join(directory("frontier-state-external-"), "outside.md");
    writeFileSync(outside, "keep-outside", { mode: 0o600 });
    symlinkSync(outside, join(root, "config/profile.md"));
    expect(() => restoreStateBackup({
      apply: true,
      backupPath: validBackup,
      force: true,
      root,
    })).toThrow(/symlink/i);
    expect(readFileSync(outside, "utf8")).toBe("keep-outside");
  });

  test("rejects malformed envelopes and invalid restore options before writing", () => {
    const variants: Array<(bundle: Record<string, unknown>) => string> = [
      () => "not-json\n",
      (bundle) => `${JSON.stringify({ ...bundle, format: "wrong" })}\n`,
      (bundle) => `${JSON.stringify({ ...bundle, createdAt: "not-a-date" })}\n`,
    ];
    for (const mutate of variants) {
      const backupPath = backup();
      const bundle = JSON.parse(readFileSync(backupPath, "utf8")) as Record<string, unknown>;
      writeFileSync(backupPath, mutate(bundle), { mode: 0o600 });
      chmodSync(backupPath, 0o600);
      expect(() => restoreStateBackup({ backupPath, root: emptyRestoreRoot() })).toThrow(
        /integrity/i,
      );
    }

    expect(() => restoreStateBackup({
      backupPath: "unused",
      force: true,
      root: emptyRestoreRoot(),
    })).toThrow(/force/i);
  });

  test("rejects non-file restore targets", () => {
    const backupPath = backup();
    const root = emptyRestoreRoot();
    mkdirSync(join(root, "config/profile.md"));

    expect(() => restoreStateBackup({ backupPath, root })).toThrow(/target is invalid/i);
  });
});
