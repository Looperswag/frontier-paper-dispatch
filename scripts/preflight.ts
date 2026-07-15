import { resolve } from "node:path";
import { ConfigError } from "../lib/runtime-config.ts";
import { runPreflight, type PreflightTarget } from "../lib/preflight.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";

const ALLOWED_TARGETS = new Set<PreflightTarget>([
  "all",
  "dry",
  "deliver",
  "ingest",
  "ingest:send",
  "push:last",
  "refine",
  "web:development",
  "web:production",
]);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main(): void {
  const rawTarget = argument("--target") ?? "all";
  if (!ALLOWED_TARGETS.has(rawTarget as PreflightTarget)) {
    throw new ConfigError([{ code: "INVALID", key: "target" }]);
  }
  const report = runPreflight({
    rootEnvPath: resolve(argument("--root-env") ?? ".env"),
    target: rawTarget as PreflightTarget,
    webEnvPath: resolve(argument("--web-env") ?? "web/.env.local"),
  });
  console.log(`preflight ok: ${report.target}; files=${report.checkedFiles.length}`);
  if (report.deprecations.length) {
    console.warn(`deprecated environment aliases: ${report.deprecations.join(", ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof ConfigError ? error.message : `Preflight failed: ${safeErrorMessage(error)}`,
  );
  process.exitCode = 1;
}
