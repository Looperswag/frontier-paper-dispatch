import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { parseEnvText } from "../../lib/env-migration.ts";

const temporaryDirectories: string[] = [];
const feedbackEnvironment = {
  FEEDBACK_SECRET: "f".repeat(40),
  WEB_BASE_URL: "https://papers.example.com",
};
const quotaEnvironment = {
  RATE_LIMIT_SECRET: "r".repeat(40),
  RATE_LIMIT_SECRET_VERSION: "1",
};
const rootEnvironment = {
  DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
  ...feedbackEnvironment,
  SERVERCHAN_SENDKEY: `SCT${"c".repeat(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
  SUPABASE_URL: "https://frontier-paper.supabase.co",
};

function serializeEnvironment(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function harness(
  envContent: string,
  rootOverrides: Record<string, string> = {},
): {
  calls: string;
  envFile: string;
  environment: NodeJS.ProcessEnv;
} {
  const directory = mkdtempSync(join(tmpdir(), "frontier-deploy-"));
  temporaryDirectories.push(directory);
  const envFile = join(directory, ".env.local");
  const calls = join(directory, "calls.log");
  const remoteState = join(directory, "remote-env.txt");
  const listCount = join(directory, "env-list-count.txt");
  const fakeNpx = join(directory, "npx");
  const rootEnvFile = join(directory, ".env");
  const parsedWebEnvironment = parseEnvText(envContent);
  const sharedWebEnvironment = Object.fromEntries(
    Object.keys(rootEnvironment)
      .filter((key) => key !== "SERVERCHAN_SENDKEY" && parsedWebEnvironment[key])
      .map((key) => [key, parsedWebEnvironment[key] as string]),
  );
  writeFileSync(envFile, envContent, { mode: 0o600 });
  writeFileSync(
    rootEnvFile,
    serializeEnvironment({ ...rootEnvironment, ...sharedWebEnvironment, ...rootOverrides }),
    { mode: 0o600 },
  );
  writeFileSync(remoteState, "APP_PASSWORD\nNEXT_PUBLIC_DEMO_MODE\n", { mode: 0o600 });
  writeFileSync(listCount, "0\n", { mode: 0o600 });
  writeFileSync(
    fakeNpx,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_NPX_CALLS"',
      'if [ "$*" = "vercel env ls production --no-color" ]; then',
      '  count="$(cat "$FAKE_ENV_LIST_COUNT")"',
      '  count=$((count + 1))',
      '  printf "%s\\n" "$count" > "$FAKE_ENV_LIST_COUNT"',
      '  [ "${FAIL_ENV_LIST_AT:-0}" = "$count" ] && exit 8',
      '  cat "$FAKE_REMOTE_ENV_STATE"',
      "  exit 0",
      "fi",
      'if [ "$1" = "vercel" ] && [ "$2" = "env" ] && [ "$3" = "rm" ]; then',
      '  key="$4"',
      '  [ "${FAIL_REMOVE_KEY:-}" = "$key" ] && exit 9',
      '  [ "${IGNORE_REMOVE_KEY:-}" = "$key" ] && exit 0',
      '  grep -vxF "$key" "$FAKE_REMOTE_ENV_STATE" > "$FAKE_REMOTE_ENV_STATE.next" || true',
      '  mv "$FAKE_REMOTE_ENV_STATE.next" "$FAKE_REMOTE_ENV_STATE"',
      "  exit 0",
      "fi",
      'if [ "$*" = "vercel link --yes" ] && [ -n "${MUTATED_ENV_CONTENT:-}" ]; then',
      '  printf "%s" "$MUTATED_ENV_CONTENT" > "$WEB_ENV_FILE"',
      '  chmod 600 "$WEB_ENV_FILE"',
      "fi",
      'if [ "$*" = "vercel --prod --yes" ] && [ "${FAIL_DEPLOY:-0}" = "1" ]; then',
      "  exit 7",
      "fi",
      'case "$*" in',
      '  *" env add "*)',
      '    payload="$(cat)"',
      `    hash="$(printf "%s" "$payload" | shasum -a 256 | awk '{print $1}')"`,
      '    printf "stdin:%s:%s\\n" "$4" "$hash" >> "$FAKE_NPX_CALLS"',
      '    ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(fakeNpx, 0o700);
  return {
    calls,
    envFile,
    environment: {
      ...process.env,
      FAKE_NPX_CALLS: calls,
      FAKE_ENV_LIST_COUNT: listCount,
      FAKE_REMOTE_ENV_STATE: remoteState,
      PATH: `${directory}:${process.env.PATH}`,
      ROOT_ENV_FILE: rootEnvFile,
      WEB_ENV_FILE: envFile,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("web deployment preflight", () => {
  test.each([
    ["FEEDBACK_SECRET", { FEEDBACK_SECRET: "z".repeat(40) }],
    ["WEB_BASE_URL", { WEB_BASE_URL: "https://different.example.com" }],
  ])(
    "rejects a Root/Web %s mismatch before any Vercel call",
    (_key, rootOverrides) => {
      const values = {
        ...feedbackEnvironment,
        ...quotaEnvironment,
        AUTH_OWNER_EMAIL: "owner@example.com",
        DEEPSEEK_API_KEY: rootEnvironment.DEEPSEEK_API_KEY,
        SUPABASE_SERVICE_ROLE_KEY: rootEnvironment.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
        SUPABASE_URL: rootEnvironment.SUPABASE_URL,
      };
      const testHarness = harness(serializeEnvironment(values), rootOverrides);

      const result = spawnSync("bash", [resolve("web/deploy.sh")], {
        encoding: "utf8",
        env: testHarness.environment,
      });

      expect(result.status).not.toBe(0);
      expect(() => readFileSync(testHarness.calls, "utf8")).toThrow();
      for (const value of Object.values(rootOverrides)) {
        expect(result.stdout + result.stderr).not.toContain(value);
      }
    },
  );

  test("does not call Vercel at all when configuration is invalid", () => {
    const testHarness = harness("NEXT_PUBLIC_DEMO_MODE=1\n");

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });

    expect(result.status).not.toBe(0);
    expect(() => readFileSync(testHarness.calls, "utf8")).toThrow();
  });

  test("preflights then uploads every private production variable without logging values", () => {
    const secrets = {
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      FEEDBACK_SECRET: "f".repeat(40),
      ...quotaEnvironment,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
      WEB_BASE_URL: "https://papers.example.com",
    };
    const testHarness = harness(
      `${Object.entries(secrets)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });
    const calls = readFileSync(testHarness.calls, "utf8");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls.split("\n")[0]).toMatch(/^vercel link /);
    for (const key of Object.keys(secrets)) expect(calls).toContain(`env add ${key} production`);
    const uploadedKeys = [...calls.matchAll(/vercel env add (\S+) production/g)].map(
      (match) => match[1],
    );
    expect(new Set(uploadedKeys)).toEqual(new Set(Object.keys(secrets)));
    for (const key of ["APP_PASSWORD", "NEXT_PUBLIC_DEMO_MODE"]) {
      expect(calls).toContain(`vercel env rm ${key} production -y`);
      expect(calls).not.toContain(`env add ${key} production`);
    }
    expect(calls).toContain("vercel --prod --yes");
    expect(calls.indexOf("env rm APP_PASSWORD production -y")).toBeLessThan(
      calls.indexOf("vercel --prod --yes"),
    );
    const output = result.stdout + result.stderr + calls;
    for (const value of Object.values(secrets).filter((value) => value.length >= 12)) {
      expect(output).not.toContain(value);
    }
  });

  test("uploads the validated snapshot even if the source file changes after link", () => {
    const originalDeepSeek = `sk-${"o".repeat(40)}`;
    const mutatedDeepSeek = `sk-${"m".repeat(40)}`;
    const values = {
      ...feedbackEnvironment,
      ...quotaEnvironment,
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: originalDeepSeek,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    };
    const serialize = (deepseek: string) =>
      `${Object.entries({ ...values, DEEPSEEK_API_KEY: deepseek })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`;
    const testHarness = harness(serialize(originalDeepSeek));
    testHarness.environment.MUTATED_ENV_CONTENT = serialize(mutatedDeepSeek);

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });
    const calls = readFileSync(testHarness.calls, "utf8");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls).toContain(`stdin:DEEPSEEK_API_KEY:${hash(originalDeepSeek)}`);
    expect(calls).not.toContain(`stdin:DEEPSEEK_API_KEY:${hash(mutatedDeepSeek)}`);
  });

  test("a failed deployment exits without a separate promotion or alias mutation", () => {
    const values = {
      ...feedbackEnvironment,
      ...quotaEnvironment,
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    };
    const testHarness = harness(
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
    testHarness.environment.FAIL_DEPLOY = "1";

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });
    const calls = readFileSync(testHarness.calls, "utf8");

    expect(result.status).toBe(7);
    expect(calls).toContain("vercel --prod --yes");
    expect(calls).not.toMatch(/alias|promote/);
  });

  test("an obsolete-key deletion failure stops before production deployment", () => {
    const values = {
      ...feedbackEnvironment,
      ...quotaEnvironment,
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    };
    const testHarness = harness(
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
    testHarness.environment.FAIL_REMOVE_KEY = "APP_PASSWORD";

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });
    const calls = readFileSync(testHarness.calls, "utf8");

    expect(result.status).not.toBe(0);
    expect(calls).toContain("vercel env rm APP_PASSWORD production -y");
    expect(calls).not.toContain("vercel --prod --yes");
  });

  test.each([1, 2])(
    "an environment listing failure at check %i stops before production deployment",
    (failureAt) => {
      const values = {
        ...feedbackEnvironment,
        ...quotaEnvironment,
        AUTH_OWNER_EMAIL: "owner@example.com",
        DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
        SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
        SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
        SUPABASE_URL: "https://frontier-paper.supabase.co",
      };
      const testHarness = harness(
        `${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`,
      );
      testHarness.environment.FAIL_ENV_LIST_AT = String(failureAt);

      const result = spawnSync("bash", [resolve("web/deploy.sh")], {
        encoding: "utf8",
        env: testHarness.environment,
      });
      const calls = readFileSync(testHarness.calls, "utf8");

      expect(result.status).not.toBe(0);
      expect(calls).not.toContain("vercel --prod --yes");
    },
  );

  test("a successful no-op removal is caught by the post-delete verification", () => {
    const values = {
      ...feedbackEnvironment,
      ...quotaEnvironment,
      AUTH_OWNER_EMAIL: "owner@example.com",
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(40)}`,
      SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
      SUPABASE_URL: "https://frontier-paper.supabase.co",
    };
    const testHarness = harness(
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
    testHarness.environment.IGNORE_REMOVE_KEY = "APP_PASSWORD";

    const result = spawnSync("bash", [resolve("web/deploy.sh")], {
      encoding: "utf8",
      env: testHarness.environment,
    });
    const calls = readFileSync(testHarness.calls, "utf8");

    expect(result.status).not.toBe(0);
    expect(calls).toContain("vercel env rm APP_PASSWORD production -y");
    expect(calls).not.toContain("vercel --prod --yes");
  });
});
