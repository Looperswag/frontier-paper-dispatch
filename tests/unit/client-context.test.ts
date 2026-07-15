import { describe, expect, test } from "vitest";
import { getClient } from "../../lib/supabase.ts";
import { withRuntimeEnvironment } from "../../lib/runtime-env.ts";

const key = (character: string) => `sb_secret_${character.repeat(40)}`;

describe("runtime-scoped service clients", () => {
  test("does not reuse a Supabase client across different environment snapshots", async () => {
    const first = await withRuntimeEnvironment(
      {
        SUPABASE_SERVICE_ROLE_KEY: key("a"),
        SUPABASE_URL: "https://first-project.supabase.co",
      },
      getClient,
    );
    const second = await withRuntimeEnvironment(
      {
        SUPABASE_SERVICE_ROLE_KEY: key("b"),
        SUPABASE_URL: "https://second-project.supabase.co",
      },
      getClient,
    );

    expect(second).not.toBe(first);
  });
});
