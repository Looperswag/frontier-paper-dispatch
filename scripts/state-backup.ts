import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateBackup, restoreStateBackup } from "../lib/state-backup.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";

interface ParsedArguments {
  readonly flags: ReadonlySet<"apply" | "force">;
  readonly options: ReadonlyMap<"output" | "root", string>;
  readonly positionals: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const flags = new Set<"apply" | "force">();
  const options = new Map<"output" | "root", string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--apply" || value === "--force") {
      const flag = value.slice(2) as "apply" | "force";
      if (flags.has(flag)) throw new Error(`duplicate option: ${value}`);
      flags.add(flag);
      continue;
    }
    const assignment = value.match(/^--(root|output)=(.+)$/);
    if (assignment) {
      const name = assignment[1] as "output" | "root";
      if (options.has(name)) throw new Error(`duplicate option: --${name}`);
      options.set(name, assignment[2]);
      continue;
    }
    if (value === "--root" || value === "--output") {
      const name = value.slice(2) as "output" | "root";
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`missing value: ${value}`);
      if (options.has(name)) throw new Error(`duplicate option: ${value}`);
      options.set(name, next);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    positionals.push(value);
  }
  return Object.freeze({
    flags: Object.freeze(flags),
    options: Object.freeze(options),
    positionals: Object.freeze(positionals),
  });
}

export function runStateBackupCommand(args: readonly string[] = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const parsed = parseArguments(rest);
  const root = resolve(parsed.options.get("root") ?? ".");
  if (command === "backup") {
    if (parsed.positionals.length || parsed.flags.size) {
      throw new Error("usage: state-backup.ts backup [--root PATH] [--output FILE]");
    }
    const report = createStateBackup({
      destination: parsed.options.get("output"),
      root,
    });
    console.log(`state backup created: ${report.destination}; files=${report.files.length}`);
    return;
  }
  if (command === "restore") {
    if (parsed.positionals.length !== 1 || parsed.options.has("output")) {
      throw new Error("usage: state-backup.ts restore BACKUP [--root PATH] [--apply] [--force]");
    }
    if (parsed.flags.has("force") && !parsed.flags.has("apply")) {
      throw new Error("--force requires --apply");
    }
    const report = restoreStateBackup({
      apply: parsed.flags.has("apply"),
      backupPath: resolve(parsed.positionals[0]),
      force: parsed.flags.has("force"),
      root,
    });
    console.log(
      `${report.applied ? "state restore applied" : "state restore dry-run"}: ${report.files.map((file) => `${file.action}:${file.path}`).join(", ")}`,
    );
    return;
  }
  throw new Error("usage: state-backup.ts <backup|restore>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runStateBackupCommand();
  } catch (error) {
    console.error(`state backup command failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
