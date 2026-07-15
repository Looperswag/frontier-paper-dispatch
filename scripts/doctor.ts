import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvText } from "../lib/env-migration.ts";
import { runPreflight } from "../lib/preflight.ts";
import { loadRootConfig } from "../lib/runtime-config.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export function supportedNodeVersion(version = process.versions.node): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major > 20 && major < 26) || (major === 20 && minor >= 19);
}

export function isShanghaiTimeZone(value: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone === "Asia/Shanghai";
  } catch {
    return false;
  }
}

async function checkFileMode(path: string): Promise<DoctorCheck> {
  try {
    const mode = (await stat(path)).mode & 0o777;
    return { name: `${path} mode`, ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8).padStart(3, "0")}`, required: true };
  } catch {
    return { name: `${path} mode`, ok: false, detail: "missing", required: true };
  }
}

export function isTCCProtectedPath(path: string, home = homedir()): boolean {
  const candidate = resolve(path);
  return ["Desktop", "Documents", "Downloads"].some((directory) => {
    const protectedRoot = resolve(home, directory);
    return candidate === protectedRoot || candidate.startsWith(`${protectedRoot}/`);
  });
}

export async function runDoctor(
  root = resolve("."),
  options: Readonly<{ home?: string; timeZone?: string }> = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "repository", ok: root.endsWith("frontier-paper-dispatch"), detail: root, required: true });
  checks.push({
    name: "macOS protected path",
    ok: !isTCCProtectedPath(root, options.home),
    detail: isTCCProtectedPath(root, options.home) ? "move the repository outside Desktop/Documents/Downloads" : "safe location",
    required: true,
  });
  checks.push({ name: "node", ok: supportedNodeVersion(), detail: process.versions.node, required: true });
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  checks.push({
    name: "system time zone",
    ok: isShanghaiTimeZone(timeZone),
    detail: isShanghaiTimeZone(timeZone) ? timeZone : `${timeZone}; set macOS time zone to Asia/Shanghai`,
    required: true,
  });
  for (const file of ["package-lock.json", "web/package-lock.json", ".env"]) {
    try {
      await stat(join(root, file));
      checks.push({ name: `${file} exists`, ok: true, detail: "present", required: true });
    } catch {
      checks.push({ name: `${file} exists`, ok: false, detail: file === ".env" ? "configure before scheduling" : "missing", required: true });
    }
  }
  const envPath = join(root, ".env");
  if (checks.some((check) => check.name === ".env exists" && check.ok)) checks.push(await checkFileMode(envPath));
  for (const plist of [
    "launchd/com.frontierpapers.deliver.plist",
    "launchd/com.frontierpapers.ingest.plist",
    "launchd/com.frontierpapers.refine.plist",
  ]) {
    try {
      const content = await readFile(join(root, plist), "utf8");
      checks.push({ name: `${plist} template`, ok: content.includes("__PROJECT_DIR__") && content.includes("__NODE_PATH__"), detail: "placeholders present", required: true });
    } catch {
      checks.push({ name: `${plist} template`, ok: false, detail: "missing", required: true });
    }
  }
  try {
    runPreflight({ rootEnvPath: envPath, target: "ingest:send" });
    checks.push({ name: "ingest:send preflight", ok: true, detail: "configuration valid", required: true });
  } catch (error) {
    checks.push({
      name: "ingest:send preflight",
      ok: false,
      detail: error instanceof Error ? error.message : "configuration invalid",
      required: true,
    });
  }
  try {
    const environment = parseEnvText(await readFile(envPath, "utf8"));
    const alert = loadRootConfig("dry", environment).alert;
    checks.push({
      name: "independent alert",
      ok: alert !== undefined,
      detail: alert ? "configured" : "ALERT_WEBHOOK_URL is missing",
      required: true,
    });
  } catch {
    checks.push({ name: "independent alert", ok: false, detail: "configuration invalid", required: true });
  }
  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const checks = await runDoctor();
  for (const check of checks) console.log(`${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`);
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
}
