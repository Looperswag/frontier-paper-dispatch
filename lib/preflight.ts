import { resolve } from "node:path";
import { parseEnvText } from "./env-migration.ts";
import {
  ConfigError,
  loadRootConfig,
  type ConfigIssue,
  type ConfigTarget,
} from "./runtime-config.ts";
import { loadWebRuntimeConfig, resolveAccessMode } from "../web/lib/runtime-config.ts";
import { readSecureFile } from "./secure-file.ts";

export type PreflightTarget = ConfigTarget | "web:development" | "web:production";

export interface PreflightOptions {
  rootEnvPath?: string;
  target: PreflightTarget;
  webEnvPath?: string;
}

export interface PreflightReport {
  checkedFiles: readonly string[];
  deprecations: readonly string[];
  status: "ok";
  target: PreflightTarget;
}

function readSecureEnv(
  path: string,
  required: boolean,
  key: ".env" | "web/.env.local",
): Record<string, string> | undefined {
  const snapshot = readSecureFile(path, { expectedMode: 0o600, key, required });
  return snapshot ? parseEnvText(snapshot.text) : undefined;
}

export function assertEnvFileSecurity(path: string, required = true): void {
  readSecureEnv(path, required, ".env");
}

function mismatch(
  issues: ConfigIssue[],
  key: string,
  rootValue: string | undefined,
  webValue: string | undefined,
): void {
  if (!rootValue || !webValue || rootValue !== webValue) {
    issues.push({ code: "CONFLICT", key, relatedKey: `web:${key}` });
  }
}

export function runPreflight(options: PreflightOptions): PreflightReport {
  const rootEnvPath = options.rootEnvPath ?? resolve(".env");
  const webEnvPath = options.webEnvPath ?? resolve("web/.env.local");
  const checkedFiles: string[] = [];
  const deprecations: string[] = [];

  if (options.target === "web:production") {
    const webEnv = readSecureEnv(webEnvPath, true, "web/.env.local") as Record<string, string>;
    checkedFiles.push(webEnvPath);
    loadWebRuntimeConfig("production", { ...webEnv, NODE_ENV: "production" });
  } else if (options.target === "web:development") {
    const webEnv = readSecureEnv(webEnvPath, true, "web/.env.local") as Record<string, string>;
    checkedFiles.push(webEnvPath);
    resolveAccessMode({ ...webEnv, NODE_ENV: "development" }, "localhost");
    loadWebRuntimeConfig("auth", webEnv);
    loadWebRuntimeConfig("data", webEnv);
    loadWebRuntimeConfig("feedback", webEnv);
    loadWebRuntimeConfig("llm", webEnv);
    loadWebRuntimeConfig("quota", webEnv);
  } else if (options.target === "all") {
    const rootEnv = readSecureEnv(rootEnvPath, true, ".env") as Record<string, string>;
    const webEnv = readSecureEnv(webEnvPath, true, "web/.env.local") as Record<string, string>;
    checkedFiles.push(rootEnvPath, webEnvPath);
    const root = loadRootConfig("all", rootEnv);
    const web = loadWebRuntimeConfig("production", { ...webEnv, NODE_ENV: "production" });
    deprecations.push(...root.deprecations);
    const issues: ConfigIssue[] = [];
    mismatch(issues, "SUPABASE_URL", root.supabase?.url, web.supabase?.url);
    mismatch(
      issues,
      "SUPABASE_SERVICE_ROLE_KEY",
      root.supabase?.serviceRoleKey,
      web.supabase?.serviceRoleKey,
    );
    mismatch(issues, "DEEPSEEK_API_KEY", root.deepseek?.apiKey, web.deepseek?.apiKey);
    mismatch(issues, "WEB_BASE_URL", root.feedback?.webBaseURL, web.feedback?.webBaseURL);
    mismatch(issues, "FEEDBACK_SECRET", root.feedback?.secret, web.feedback?.secret);
    if (issues.length) throw new ConfigError(issues);
  } else {
    const env = readSecureEnv(rootEnvPath, options.target !== "dry", ".env") ?? {};
    if (Object.keys(env).length) checkedFiles.push(rootEnvPath);
    const root = loadRootConfig(options.target, env);
    deprecations.push(...root.deprecations);
  }

  return Object.freeze({
    checkedFiles: Object.freeze([...checkedFiles]),
    deprecations: Object.freeze([...deprecations]),
    status: "ok" as const,
    target: options.target,
  });
}
