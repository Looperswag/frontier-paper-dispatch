import { describe, expect, test } from "vitest";
import { ConfigError } from "../../lib/runtime-config.ts";
import { safeErrorMessage } from "../../lib/safe-error.ts";
import { withRuntimeEnvironment } from "../../lib/runtime-env.ts";

describe("safeErrorMessage", () => {
  test("redacts raw and URL-encoded configured secrets", () => {
    const secret = "private token/with spaces";
    const error = new Error(
      `provider failed with ${secret}; encoded=${encodeURIComponent(secret)}`,
    );

    const message = safeErrorMessage(error, { API_TOKEN: secret });

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(encodeURIComponent(secret));
  });

  test.each([
    ["SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"],
    ["SERVERCHAN_KEY", `sctp123t${"k".repeat(32)}`],
  ])("redacts configured %s values and known token shapes", (key, secret) => {
    const message = safeErrorMessage(
      new Error(`failed ${secret} at https://push.example.com/send/${secret}.send`),
      { [key]: secret },
    );
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
  });

  test("redacts URL credentials and sensitive query parameters", () => {
    const message = safeErrorMessage(
      new Error(
        "failed https://user:password@example.com/path?token=query-secret&safe=value#fragment",
      ),
      {},
    );

    expect(message).not.toMatch(/user|password|query-secret|fragment/);
    expect(message).toContain("https://example.com/path");
  });

  test("keeps safe ConfigError key guidance", () => {
    const error = new ConfigError([{ code: "MISSING", key: "SUPABASE_URL" }]);
    expect(safeErrorMessage(error, {})).toContain("SUPABASE_URL");
  });

  test("does not stringify arbitrary rejection objects", () => {
    expect(safeErrorMessage({ message: "secret body", payload: "private" }, {})).toBe(
      "Operation failed with a non-Error rejection",
    );
  });

  test("bounds unusually long downstream messages", () => {
    expect(safeErrorMessage(new Error("x".repeat(5_000)), {}).length).toBeLessThanOrEqual(1_024);
  });

  test("uses the active immutable runtime snapshot when no env argument is passed", () => {
    const sentinel = "injected-runtime-secret-sentinel";
    const message = withRuntimeEnvironment({ API_TOKEN: sentinel }, () =>
      safeErrorMessage(new Error(`provider echoed ${sentinel}`)),
    );
    expect(message).not.toContain(sentinel);
    expect(message).toContain("[REDACTED]");
  });
});
