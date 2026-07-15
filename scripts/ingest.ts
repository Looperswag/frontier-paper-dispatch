import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArxiv } from "./fetchers/arxiv.ts";
import { fetchHuggingFace } from "./fetchers/huggingface.ts";
import { fetchGitHub } from "./fetchers/github.ts";
import { fetchBlogs } from "./fetchers/blogs.ts";
import { fetchOpenAlex } from "./fetchers/openalex.ts";
import { fetchACLAnthology } from "./fetchers/acl.ts";
import { dedupe } from "../lib/normalize.ts";
import { rankTop } from "./rank.ts";
import { summarizeAll } from "./summarize.ts";
import { renderDigest, pushDigest } from "./digest.ts";
import { upsertItems, saveDigest, fetchFeedback, feedbackSummary, filterRecentlyDelivered } from "../lib/supabase.ts";
import { runIngest } from "./ingest-runner.ts";
import { loadRootConfig } from "../lib/runtime-config.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";
import { shanghaiDateKey } from "../lib/time.ts";
import {
  finishPipelineRun,
  heartbeatPipelineRun,
  recordSourceRun,
  startPipelineRun,
} from "../lib/pipeline-run.ts";
import {
  currentRuntimeEnvironment,
  loadRuntimeEnvironment,
  withRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../lib/runtime-env.ts";

export const ACTIVE_FETCHERS = [
  ["arxiv", fetchArxiv],
  ["huggingface", fetchHuggingFace],
  ["github", fetchGitHub],
  ["blog", fetchBlogs],
  ["acl", fetchACLAnthology],
  ["openalex", fetchOpenAlex],
] as const;

const SCHEDULED_INGEST_HOUR = 22;

export function resolveIngestRunInstant(
  args: readonly string[],
  now: Date = new Date(),
): Date {
  const scheduledDateIndexes = args.flatMap((argument, index) =>
    argument === "--scheduled-date" ? [index] : []
  );
  if (!scheduledDateIndexes.length) {
    shanghaiDateKey(now);
    return new Date(now);
  }
  const index = scheduledDateIndexes[0];
  const value = args[index + 1];
  if (
    scheduledDateIndexes.length !== 1 ||
    !args.includes("--send") ||
    args.includes("--dry") ||
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new Error("Invalid scheduled ingest date");
  }

  const scheduled = new Date(`${value}T${SCHEDULED_INGEST_HOUR}:00:00+08:00`);
  const today = shanghaiDateKey(now);
  const yesterday = shanghaiDateKey(new Date(now.getTime() - 86_400_000));
  if (
    !Number.isFinite(scheduled.getTime()) ||
    shanghaiDateKey(scheduled) !== value ||
    (value !== today && value !== yesterday) ||
    scheduled.getTime() > now.getTime()
  ) {
    throw new Error("Invalid scheduled ingest date");
  }
  return scheduled;
}

export async function runIngestCommand(
  args: readonly string[] = process.argv,
  injectedEnv?: RuntimeEnvironment,
): Promise<void> {
  const dry = args.includes("--dry");
  const send = args.includes("--send");
  const runInstant = resolveIngestRunInstant(args);
  const env = injectedEnv ?? loadRuntimeEnvironment({ required: !dry });
  await withRuntimeEnvironment(env, async () => {
    const target = dry ? "dry" : send ? "ingest:send" : "ingest";
    const config = loadRootConfig(target, currentRuntimeEnvironment());
    if (config.deprecations.length) {
      console.warn(`deprecated environment aliases: ${config.deprecations.join(", ")}`);
    }
    await runIngest(
      { dry, send },
      {
        clock: () => new Date(runInstant),
        dedupe,
        feedbackSummary,
        fetchFeedback,
        fetchers: ACTIVE_FETCHERS,
        logger: console,
        pushDigest,
        rankTop,
        renderDigest,
        saveDigest,
        summarizeAll,
        upsertItems,
        filterRecentlyDelivered,
        pipeline: {
          start: startPipelineRun,
          heartbeat: heartbeatPipelineRun,
          recordSource: recordSourceRun,
          finish: finishPipelineRun,
        },
      },
    );
  });
}

export async function runIngestEntry(
  args: readonly string[] = process.argv,
  baseEnv: RuntimeEnvironment = process.env,
): Promise<void> {
  let env: RuntimeEnvironment | undefined;
  try {
    env = loadRuntimeEnvironment({ baseEnv, required: !args.includes("--dry") });
    await runIngestCommand(args, env);
  } catch (error) {
    console.error(`ingest failed: ${safeErrorMessage(error, env ?? baseEnv)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runIngestEntry();
}
