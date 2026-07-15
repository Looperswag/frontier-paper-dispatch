import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length) {
    rmSync(temporaryPaths.pop()!, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function copy(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(repositoryRoot, source), destination);
}

function executable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function runnerFixture(): {
  childLog: string;
  fakeNode: string;
  root: string;
  run: (job?: "deliver" | "ingest" | "refine", environment?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
} {
  const root = temporaryDirectory("frontier-scheduler-runner-");
  const runner = join(root, "scripts/run-scheduled.sh");
  const fakeNode = join(root, "bin/fake-node");
  const childLog = join(root, "child-invocations.log");
  copy("scripts/run-scheduled.sh", runner);
  copy("scripts/schedule-token.mjs", join(root, "scripts/schedule-token.mjs"));
  executable(
    fakeNode,
    `#!/bin/sh
if [ "\${1}" = "${root}/scripts/schedule-token.mjs" ]; then
  printf '%s:%s\\n' "\${2}" "\${FAKE_SCHEDULE_DATE:-2026-07-15}"
  exit "\${FAKE_SCHEDULE_EXIT:-0}"
fi
printf '%s\\n' "$*" >> "\${FAKE_NODE_LOG:?}"
exit "\${FAKE_NODE_EXIT:-0}"
`,
  );
  return {
    childLog,
    fakeNode,
    root,
    run: (job = "ingest", environment = {}) =>
      spawnSync("/bin/zsh", [runner, job, fakeNode], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, FAKE_NODE_LOG: childLog, ...environment },
      }),
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function installerFixture(): {
  agents: string;
  home: string;
  launchLog: string;
  root: string;
  run: (environment?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
} {
  const parent = temporaryDirectory("frontier-scheduler-install-");
  const rootInput = join(parent, "project &|\\<>\"'");
  const home = join(parent, "home");
  const agents = join(home, "Library/LaunchAgents");
  const fakeBin = join(parent, "fake-bin");
  const launchLog = join(parent, "launchctl.log");
  mkdirSync(rootInput, { recursive: true });
  const root = realpathSync(rootInput);
  mkdirSync(agents, { recursive: true });
  copy("scripts/install-cron.sh", join(root, "scripts/install-cron.sh"));
  copy("scripts/render-launchd-plist.mjs", join(root, "scripts/render-launchd-plist.mjs"));
  copy("launchd/com.frontierpapers.ingest.plist", join(root, "launchd/com.frontierpapers.ingest.plist"));
  copy("launchd/com.frontierpapers.deliver.plist", join(root, "launchd/com.frontierpapers.deliver.plist"));
  copy("launchd/com.frontierpapers.refine.plist", join(root, "launchd/com.frontierpapers.refine.plist"));
  executable(join(fakeBin, "npm"), "#!/bin/sh\nexit 0\n");
  executable(
    join(fakeBin, "plutil"),
    `#!/bin/sh
case "\${2:-}" in
  *"\${FAIL_PLUTIL_JOB:-__never__}"*) exit 65 ;;
esac
exit 0
`,
  );
  executable(
    join(fakeBin, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_LAUNCHCTL_LOG:?}"
case "$1:\${2:-}" in
  load:*)
    if [ -n "\${FAIL_LAUNCH_JOB:-}" ]; then
      case "\${2:-}" in *"\${FAIL_LAUNCH_JOB}"*) exit 69 ;; esac
    fi
    ;;
esac
exit 0
`,
  );
  return {
    agents,
    home,
    launchLog,
    root,
    run: (environment = {}) =>
      spawnSync("bash", [join(root, "scripts/install-cron.sh")], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_LAUNCHCTL_LOG: launchLog,
          HOME: home,
          NODE_BIN: process.execPath,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          ...environment,
        },
      }),
  };
}

describe("scheduled runner", () => {
  test("requires an absolute executable Node path", () => {
    const root = temporaryDirectory("frontier-scheduler-node-");
    const runner = join(root, "scripts/run-scheduled.sh");
    copy("scripts/run-scheduled.sh", runner);

    const result = spawnSync("/bin/zsh", [runner, "ingest", "node"], { encoding: "utf8" });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("absolute executable Node path");
  });

  test.each(["99999999", "-1"])("recovers a stale or malformed %s lock owner", (pid) => {
    const fixture = runnerFixture();
    const lock = join(fixture.root, ".runtime/ingest.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${pid}\n`, "utf8");

    const result = fixture.run();

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.childLog, "utf8")).toContain("scripts/ingest.ts --send");
    expect(existsSync(lock)).toBe(false);
  });

  test("does not steal a lock owned by a live process", () => {
    const fixture = runnerFixture();
    const lock = join(fixture.root, ".runtime/ingest.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`, "utf8");

    const result = fixture.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already running");
    expect(existsSync(fixture.childLog)).toBe(false);
  });

  test.each([
    ["ingest" as const, "ingest.log"],
    ["deliver" as const, "delivery.log"],
  ])("retains exactly three archives for %s when the active log exceeds 5 MiB", (job, logName) => {
    const fixture = runnerFixture();
    const log = join(fixture.root, logName);
    writeFileSync(log, "", "utf8");
    truncateSync(log, 5 * 1024 * 1024 + 1);
    writeFileSync(`${log}.1`, "one", "utf8");
    writeFileSync(`${log}.2`, "two", "utf8");
    writeFileSync(`${log}.3`, "three", "utf8");
    writeFileSync(`${log}.4`, "four", "utf8");

    const result = fixture.run(job);

    expect(result.status).toBe(0);
    expect(readFileSync(`${log}.2`, "utf8")).toBe("one");
    expect(readFileSync(`${log}.3`, "utf8")).toBe("two");
    expect(existsSync(`${log}.4`)).toBe(false);
    expect(readFileSync(`${log}.1`).byteLength).toBe(5 * 1024 * 1024 + 1);
  });

  test("preserves the child exit code and leaves the schedule retryable", () => {
    const fixture = runnerFixture();

    const result = fixture.run("ingest", { FAKE_NODE_EXIT: "37" });

    expect(result.status).toBe(37);
    expect(existsSync(join(fixture.root, ".runtime/ingest.lock"))).toBe(false);
    expect(existsSync(join(fixture.root, ".runtime/ingest.last-success"))).toBe(false);
  });

  test("retries an incomplete schedule and writes the marker only after success", () => {
    const fixture = runnerFixture();

    const incomplete = fixture.run("ingest", { FAKE_NODE_EXIT: "1" });
    const retry = fixture.run("ingest");

    expect(incomplete.status).toBe(1);
    expect(retry.status).toBe(0);
    expect(readFileSync(fixture.childLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(join(fixture.root, ".runtime/ingest.last-success"), "utf8")).toBe(
      "ingest:2026-07-15\n",
    );
  });

  test("marks a successful schedule and skips duplicate startup or wake invocations", () => {
    const fixture = runnerFixture();

    const first = fixture.run();
    const second = fixture.run();

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("schedule already completed");
    const invocations = readFileSync(fixture.childLog, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("--scheduled-date 2026-07-15");
    expect(readFileSync(join(fixture.root, ".runtime/ingest.last-success"), "utf8")).toBe(
      "ingest:2026-07-15\n",
    );
  });

  test("runs the delivery worker on every interval without a daily success marker", () => {
    const fixture = runnerFixture();

    const first = fixture.run("deliver");
    const second = fixture.run("deliver");

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(readFileSync(fixture.childLog, "utf8").trim().split("\n")).toEqual([
      `--import tsx ${fixture.root}/scripts/delivery-worker.ts`,
      `--import tsx ${fixture.root}/scripts/delivery-worker.ts`,
    ]);
    expect(existsSync(join(fixture.root, ".runtime/deliver.last-success"))).toBe(false);
  });

  test("creates local task logs with owner-only permissions", () => {
    const fixture = runnerFixture();
    const log = join(fixture.root, "delivery.log");
    writeFileSync(log, "existing private log\n", "utf8");
    chmodSync(log, 0o644);

    const result = fixture.run("deliver");

    expect(result.status).toBe(0);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });
});

describe("schedule tokens", () => {
  test.each([
    ["ingest", "2026-07-15T13:59:00.000Z", "ingest:2026-07-14"],
    ["ingest", "2026-07-15T14:00:00.000Z", "ingest:2026-07-15"],
    ["refine", "2026-07-19T14:59:00.000Z", "refine:2026-07-12"],
    ["refine", "2026-07-19T15:00:00.000Z", "refine:2026-07-19"],
  ])("finds the latest due %s occurrence", (job, now, expected) => {
    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/schedule-token.mjs"), job, now],
      { encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });
});

describe("LaunchAgent installer", () => {
  test("escapes arbitrary paths, validates staged plists, and never writes to the real HOME", () => {
    const fixture = installerFixture();
    const expectedIntervals: Record<string, number> = {
      deliver: 900,
      ingest: 900,
      refine: 1800,
    };

    const result = fixture.run();

    expect(result.status, result.stderr).toBe(0);
    for (const job of ["deliver", "ingest", "refine"]) {
      const destination = join(fixture.agents, `com.frontierpapers.${job}.plist`);
      const xml = readFileSync(destination, "utf8");
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain(
        `<string>${xmlEscape(fixture.root)}/scripts/run-scheduled.sh</string>`,
      );
      expect(xml).toContain(`<string>${xmlEscape(process.execPath)}</string>`);
      expect(xml).toContain("<key>RunAtLoad</key>");
      expect(xml).toContain("<true/>");
      expect(xml).toContain("<key>Umask</key>");
      expect(xml).toContain("<integer>63</integer>");
      expect(xml).toContain(
        `<key>StartInterval</key>\n  <integer>${expectedIntervals[job]}</integer>`,
      );
      expect(xml).not.toContain("__PROJECT_DIR__");
      expect(xml).not.toContain("__NODE_PATH__");
    }
    expect(readFileSync(fixture.launchLog, "utf8")).toContain(`load ${fixture.agents}`);
    expect(readdirSync(fixture.agents).filter((name) => name.startsWith(".frontierpapers.install."))).toEqual([]);
  });

  test("validates every staged plist before replacing either installed file", () => {
    const fixture = installerFixture();
    const ingest = join(fixture.agents, "com.frontierpapers.ingest.plist");
    const deliver = join(fixture.agents, "com.frontierpapers.deliver.plist");
    const refine = join(fixture.agents, "com.frontierpapers.refine.plist");
    writeFileSync(ingest, "old-ingest", "utf8");
    writeFileSync(deliver, "old-deliver", "utf8");
    writeFileSync(refine, "old-refine", "utf8");

    const result = fixture.run({ FAIL_PLUTIL_JOB: "refine" });

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}\n${existsSync(fixture.launchLog) ? readFileSync(fixture.launchLog, "utf8") : "no launch log"}`,
    ).not.toBe(0);
    expect(readFileSync(ingest, "utf8")).toBe("old-ingest");
    expect(readFileSync(deliver, "utf8")).toBe("old-deliver");
    expect(readFileSync(refine, "utf8")).toBe("old-refine");
    expect(existsSync(fixture.launchLog)).toBe(false);
    expect(readdirSync(fixture.agents).filter((name) => name.startsWith(".frontierpapers.install."))).toEqual([]);
  });

  test("rolls both plist files back if launchd rejects either new job", () => {
    const fixture = installerFixture();
    const ingest = join(fixture.agents, "com.frontierpapers.ingest.plist");
    const deliver = join(fixture.agents, "com.frontierpapers.deliver.plist");
    const refine = join(fixture.agents, "com.frontierpapers.refine.plist");
    writeFileSync(ingest, "old-ingest", "utf8");
    writeFileSync(deliver, "old-deliver", "utf8");
    writeFileSync(refine, "old-refine", "utf8");

    const result = fixture.run({ FAIL_LAUNCH_JOB: "refine" });

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}\n${existsSync(fixture.launchLog) ? readFileSync(fixture.launchLog, "utf8") : "no launch log"}`,
    ).not.toBe(0);
    expect(readFileSync(ingest, "utf8")).toBe("old-ingest");
    expect(readFileSync(deliver, "utf8")).toBe("old-deliver");
    expect(readFileSync(refine, "utf8")).toBe("old-refine");
    expect(readdirSync(fixture.agents).filter((name) => name.startsWith(".frontierpapers.install."))).toEqual([]);
  });
});
