import { databaseData, isDatabaseUuid } from "./db-result.ts";
import { getClient } from "./supabase.ts";

export type PipelineStatus = "succeeded" | "degraded" | "failed" | "skipped";
export type PipelineRunState = "running" | PipelineStatus;
export type SourceRunStatus = "succeeded" | "failed" | "empty";

function record(operation: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation}: invalid response`);
  }
  return value as Record<string, unknown>;
}

export async function startPipelineRun(runDate: string, runId: string): Promise<{
  acquired: boolean;
  activeRunId: string;
  status: PipelineRunState;
}> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !isDatabaseUuid(runId)) {
    throw new Error("Invalid pipeline run identity");
  }
  const result = await getClient().then((db) =>
    db.rpc("start_pipeline_run", { p_run_date: runDate, p_run_id: runId }),
  );
  const data = databaseData("pipeline.start", result);
  const row = Array.isArray(data) ? data[0] : data;
  const value = record("pipeline.start", row);
  if (
    typeof value.acquired !== "boolean" ||
    typeof value.active_run_id !== "string" ||
    !isDatabaseUuid(value.active_run_id) ||
    typeof value.run_status !== "string" ||
    !["running", "succeeded", "degraded", "failed", "skipped"].includes(value.run_status)
  ) {
    throw new Error("pipeline.start: invalid response");
  }
  return {
    acquired: value.acquired,
    activeRunId: value.active_run_id,
    status: value.run_status as PipelineRunState,
  };
}

export async function heartbeatPipelineRun(runDate: string, runId: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !isDatabaseUuid(runId)) {
    throw new Error("Invalid pipeline run identity");
  }
  const result = await getClient().then((db) =>
    db.rpc("heartbeat_pipeline_run", { p_run_date: runDate, p_run_id: runId }),
  );
  databaseData("pipeline.heartbeat", result);
}

export async function recordSourceRun(input: {
  runId: string;
  source: string;
  status: SourceRunStatus;
  itemCount: number;
  errorMessage?: string | null;
  startedAt: string;
  finishedAt: string;
}): Promise<void> {
  if (
    !isDatabaseUuid(input.runId) ||
    !input.source ||
    !Number.isInteger(input.itemCount) ||
    input.itemCount < 0 ||
    !["succeeded", "failed", "empty"].includes(input.status)
  ) {
    throw new Error("Invalid source run");
  }
  const result = await getClient().then((db) =>
    db.rpc("record_source_run", {
      p_run_id: input.runId,
      p_source: input.source,
      p_status: input.status,
      p_item_count: input.itemCount,
      p_error_message: input.errorMessage ?? null,
      p_started_at: input.startedAt,
      p_finished_at: input.finishedAt,
    }),
  );
  databaseData("pipeline.source", result);
}

export async function finishPipelineRun(input: {
  runId: string;
  status: PipelineStatus;
  candidateCount: number;
  sourceCount: number;
  errorMessage?: string | null;
}): Promise<void> {
  if (
    !isDatabaseUuid(input.runId) ||
    !["succeeded", "degraded", "failed", "skipped"].includes(input.status) ||
    !Number.isInteger(input.candidateCount) ||
    !Number.isInteger(input.sourceCount)
  ) {
    throw new Error("Invalid pipeline completion");
  }
  const result = await getClient().then((db) =>
    db.rpc("finish_pipeline_run", {
      p_run_id: input.runId,
      p_status: input.status,
      p_candidate_count: input.candidateCount,
      p_source_count: input.sourceCount,
      p_error_message: input.errorMessage ?? null,
    }),
  );
  databaseData("pipeline.finish", result);
}
