import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfigError } from "../../lib/runtime-config.ts";
import { runIngestCommand } from "../../scripts/ingest.ts";
import { runSendLastCommand } from "../../scripts/send-last.ts";
import { runRefineCommand } from "../../scripts/refine-profile.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ingest command preflight", () => {
  test("fails before any provider call when required configuration is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runIngestCommand(["node", "ingest"], {})).rejects.toBeInstanceOf(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps the zero-config dry target available", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("stop after preflight");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runIngestCommand(["node", "ingest", "--dry"], {})).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  test("provider consumers use the same injected environment snapshot", async () => {
    const injectedToken = "github_pat_injected_snapshot_only";
    const fetchMock = vi.fn(async () => {
      throw new Error("stop after config propagation");
    });
    vi.stubGlobal("fetch", fetchMock);

    await runIngestCommand(["node", "ingest", "--dry"], { GITHUB_TOKEN: injectedToken });

    const githubCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.github.com"));
    expect(githubCall).toBeTruthy();
    const headers = new Headers((githubCall?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${injectedToken}`);
  });

  test("send-last and refine also fail at their capability boundary", async () => {
    await expect(runSendLastCommand({})).rejects.toBeInstanceOf(ConfigError);
    await expect(runRefineCommand(["node", "refine"], {})).rejects.toBeInstanceOf(ConfigError);
  });
});
