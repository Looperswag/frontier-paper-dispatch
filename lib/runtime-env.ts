import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { parseEnvText } from "./env-migration.ts";
import { readSecureFile } from "./secure-file.ts";
import { ConfigError } from "./runtime-config.ts";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const environmentStorage = new AsyncLocalStorage<RuntimeEnvironment>();

function immutableEnvironment(env: RuntimeEnvironment): RuntimeEnvironment {
  return Object.freeze({ ...env });
}

export function currentRuntimeEnvironment(): RuntimeEnvironment {
  return environmentStorage.getStore() ?? process.env;
}

export function withRuntimeEnvironment<T>(
  env: RuntimeEnvironment,
  operation: () => T,
): T {
  return environmentStorage.run(immutableEnvironment(env), operation);
}

export function loadRuntimeEnvironment(
  options: {
    baseEnv?: RuntimeEnvironment;
    path?: string;
    required?: boolean;
  } = {},
): RuntimeEnvironment {
  const snapshot = readSecureFile(resolve(options.path ?? ".env"), {
    expectedMode: 0o600,
    key: ".env",
    required: options.required ?? true,
  });
  const fileEnvironment = snapshot ? parseEnvText(snapshot.text) : {};
  const baseEnvironment = options.baseEnv ?? process.env;
  const conflicts = Object.entries(fileEnvironment)
    .filter(([key, value]) => baseEnvironment[key] !== undefined && baseEnvironment[key] !== value)
    .map(([key]) => ({
      code: "CONFLICT" as const,
      key,
      relatedKey: "inherited environment",
    }));
  if (conflicts.length) throw new ConfigError(conflicts);
  return immutableEnvironment({ ...baseEnvironment, ...fileEnvironment });
}
