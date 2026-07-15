import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadWebRuntimeConfig } from "../../web/lib/runtime-config.ts";

function webBuildStep(workflow: string): string {
  const marker = "      - run: npm --prefix web run build";
  const starts = [...workflow.matchAll(/^ {6}- run: npm --prefix web run build$/gm)];
  if (starts.length !== 1 || starts[0].index === undefined) {
    throw new Error("Expected exactly one Web build step");
  }
  const start = starts[0].index;
  const nextStep = workflow.indexOf("\n      - ", start + marker.length);
  const end = nextStep < 0 ? workflow.length : nextStep;
  return workflow.slice(start, end);
}

function validateWebBuildConfiguration(workflow: string): void {
  const buildStep = webBuildStep(workflow);
  const value = (key: string) =>
    buildStep.match(new RegExp(`^ {10}${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  loadWebRuntimeConfig("production", {
    AUTH_OWNER_EMAIL: value("AUTH_OWNER_EMAIL"),
    DEEPSEEK_API_KEY: value("DEEPSEEK_API_KEY"),
    FEEDBACK_SECRET: value("FEEDBACK_SECRET"),
    RATE_LIMIT_SECRET: value("RATE_LIMIT_SECRET"),
    RATE_LIMIT_SECRET_VERSION: value("RATE_LIMIT_SECRET_VERSION"),
    SUPABASE_PUBLISHABLE_KEY: value("SUPABASE_PUBLISHABLE_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: value("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_URL: value("SUPABASE_URL"),
    WEB_BASE_URL: value("WEB_BASE_URL"),
  });
}

function removeWebBuildEnvironmentKey(workflow: string, key: string): string {
  const step = webBuildStep(workflow);
  const start = workflow.indexOf(step);
  const end = start + step.length;
  const mutatedStep = step.replace(new RegExp(`^          ${key}:.*(?:\\n|$)`, "m"), "");
  if (mutatedStep === step) throw new Error(`Missing ${key} in Web build step`);
  return workflow.slice(0, start) + mutatedStep + workflow.slice(end);
}

describe("CI Web build configuration", () => {
  test("uses a production-valid synthetic private configuration", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(() => validateWebBuildConfiguration(workflow)).not.toThrow();
    expect(workflow).not.toMatch(/APP_PASSWORD|NEXT_PUBLIC_DEMO_MODE/);
  });

  test.each([
    "FEEDBACK_SECRET",
    "RATE_LIMIT_SECRET",
    "RATE_LIMIT_SECRET_VERSION",
    "WEB_BASE_URL",
  ])(
    "does not borrow %s from another workflow step",
    (key) => {
      const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
      const mutated = removeWebBuildEnvironmentKey(workflow, key);

      expect(() => validateWebBuildConfiguration(mutated)).toThrow(key);
    },
  );
});
