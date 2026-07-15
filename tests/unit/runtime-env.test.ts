import { describe, expect, test } from "vitest";
import {
  currentRuntimeEnvironment,
  loadRuntimeEnvironment,
  withRuntimeEnvironment,
} from "../../lib/runtime-env.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runtime environment context", () => {
  test("keeps immutable injected snapshots isolated across concurrent work", async () => {
    const values = await Promise.all([
      withRuntimeEnvironment({ GITHUB_TOKEN: "first" }, async () => {
        await Promise.resolve();
        return currentRuntimeEnvironment().GITHUB_TOKEN;
      }),
      withRuntimeEnvironment({ GITHUB_TOKEN: "second" }, async () => {
        await Promise.resolve();
        return currentRuntimeEnvironment().GITHUB_TOKEN;
      }),
    ]);

    expect(values).toEqual(["first", "second"]);
    expect(Object.isFrozen(currentRuntimeEnvironment())).toBe(false);
  });

  test("rejects a file/inherited environment conflict without revealing either value", () => {
    const directory = mkdtempSync(join(tmpdir(), "frontier-runtime-env-"));
    const path = join(directory, ".env");
    const fileSecret = "file-secret-value";
    const inheritedSecret = "inherited-secret-value";
    writeFileSync(path, `DEEPSEEK_API_KEY=${fileSecret}\n`, { mode: 0o600 });
    try {
      const error = (() => {
        try {
          loadRuntimeEnvironment({ baseEnv: { DEEPSEEK_API_KEY: inheritedSecret }, path });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      const rendered = String(error) + JSON.stringify(error);
      expect(rendered).toContain("DEEPSEEK_API_KEY");
      expect(rendered).not.toContain(fileSecret);
      expect(rendered).not.toContain(inheritedSecret);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
