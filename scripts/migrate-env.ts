import { resolve } from "node:path";
import { migrateEnvFile } from "../lib/env-migration.ts";
import { ConfigError } from "../lib/runtime-config.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";

try {
  const path = resolve(process.argv[2] ?? ".env");
  const result = migrateEnvFile(path);
  if (result.migratedKeys.length) {
    console.log(`migrated environment keys: ${result.migratedKeys.join(", ")}`);
    console.log("created a mode-0600 ignored backup");
  } else if (result.permissionsFixed) {
    console.log("repaired environment file mode to 0600");
  } else {
    console.log("environment aliases already canonical");
  }
} catch (error) {
  console.error(
    error instanceof ConfigError
      ? error.message
      : `Environment migration failed: ${safeErrorMessage(error)}`,
  );
  process.exitCode = 1;
}
