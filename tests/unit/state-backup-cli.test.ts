import { afterEach, expect, test, vi } from "vitest";
import { runStateBackupCommand } from "../../scripts/state-backup.ts";

const mocks = vi.hoisted(() => ({
  createStateBackup: vi.fn(() => ({ destination: "/tmp/state.json", files: [] })),
  restoreStateBackup: vi.fn(() => ({ applied: false, files: [] })),
}));

vi.mock("../../lib/state-backup.ts", () => ({
  createStateBackup: mocks.createStateBackup,
  restoreStateBackup: mocks.restoreStateBackup,
}));

afterEach(() => vi.restoreAllMocks());

test.each([
  ["unknown option", ["backup", "--unknown"]],
  ["missing option value", ["backup", "--output"]],
  ["duplicate option", ["backup", "--root", "/tmp", "--root=/tmp"]],
  ["force without apply", ["restore", "missing.json", "--force"]],
])("state backup CLI rejects %s", (_name, args) => {
  expect(() => runStateBackupCommand(args)).toThrow();
});

test("state backup CLI runs validated backup and restore commands", () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  runStateBackupCommand(["backup", "--root=/tmp/repository", "--output", "/tmp/state.json"]);
  runStateBackupCommand(["restore", "/tmp/state.json", "--root", "/tmp/repository", "--apply", "--force"]);

  expect(mocks.createStateBackup).toHaveBeenCalledWith({
    destination: "/tmp/state.json",
    root: "/tmp/repository",
  });
  expect(mocks.restoreStateBackup).toHaveBeenCalledWith({
    apply: true,
    backupPath: "/tmp/state.json",
    force: true,
    root: "/tmp/repository",
  });
  expect(console.log).toHaveBeenCalledTimes(2);
});

test("state backup CLI rejects an unknown command", () => {
  expect(() => runStateBackupCommand(["destroy"])).toThrow(/usage/i);
});
