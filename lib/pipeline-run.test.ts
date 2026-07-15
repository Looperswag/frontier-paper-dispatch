import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase.ts", () => ({
  getClient: vi.fn(async () => ({ rpc: mocks.rpc })),
}));

import {
  finishPipelineRun,
  heartbeatPipelineRun,
  recordSourceRun,
  startPipelineRun,
} from "./pipeline-run.ts";

const runId = "77777777-7777-4777-8777-777777777777";

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("pipeline run client", () => {
  test("starts a run and validates the database acknowledgement", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ acquired: true, active_run_id: runId, run_status: "running" }],
      error: null,
    });

    await expect(startPipelineRun("2026-07-15", runId)).resolves.toEqual({
      acquired: true,
      activeRunId: runId,
      status: "running",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("start_pipeline_run", {
      p_run_date: "2026-07-15",
      p_run_id: runId,
    });
  });

  test("rejects an unknown run status from the database", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ acquired: true, active_run_id: runId, run_status: "unknown" }],
      error: null,
    });

    await expect(startPipelineRun("2026-07-15", runId)).rejects.toThrow(
      "pipeline.start: invalid response",
    );
  });

  test("heartbeats the exact date and fencing token", async () => {
    await expect(heartbeatPipelineRun("2026-07-15", runId)).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("heartbeat_pipeline_run", {
      p_run_date: "2026-07-15",
      p_run_id: runId,
    });

    await expect(heartbeatPipelineRun("not-a-date", runId)).rejects.toThrow(
      "Invalid pipeline run identity",
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  test("records bounded source health", async () => {
    const input = {
      runId,
      source: "arxiv",
      status: "succeeded" as const,
      itemCount: 4,
      startedAt: "2026-07-15T14:00:00.000Z",
      finishedAt: "2026-07-15T14:00:01.000Z",
    };
    await expect(recordSourceRun(input)).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("record_source_run", {
      p_error_message: null,
      p_finished_at: input.finishedAt,
      p_item_count: 4,
      p_run_id: runId,
      p_source: "arxiv",
      p_started_at: input.startedAt,
      p_status: "succeeded",
    });

    await expect(recordSourceRun({ ...input, itemCount: -1 })).rejects.toThrow(
      "Invalid source run",
    );
  });

  test("finishes only a valid bounded run outcome", async () => {
    await expect(finishPipelineRun({
      runId,
      status: "degraded",
      candidateCount: 10,
      sourceCount: 6,
      errorMessage: "one source failed",
    })).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("finish_pipeline_run", {
      p_candidate_count: 10,
      p_error_message: "one source failed",
      p_run_id: runId,
      p_source_count: 6,
      p_status: "degraded",
    });

    await expect(finishPipelineRun({
      runId,
      status: "succeeded",
      candidateCount: 1.5,
      sourceCount: 6,
    })).rejects.toThrow("Invalid pipeline completion");
  });
});
