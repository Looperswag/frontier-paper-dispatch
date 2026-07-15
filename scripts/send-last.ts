// 只重发"已存在数据库里的最新 digest" —— 调推送配置时免去重跑采集+DeepSeek。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "../lib/supabase.ts";
import { assertDatabaseIntegrity, databaseData } from "../lib/db-result.ts";
import { loadRootConfig } from "../lib/runtime-config.ts";
import { safeErrorMessage } from "../lib/safe-error.ts";
import {
  currentRuntimeEnvironment,
  loadRuntimeEnvironment,
  withRuntimeEnvironment,
  type RuntimeEnvironment,
} from "../lib/runtime-env.ts";
import { assertDigestFeedbackLinks, replayDigest } from "./digest.ts";

function isDateKey(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  ) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

export async function runSendLastCommand(
  injectedEnv?: RuntimeEnvironment,
  now: Date | number = Date.now(),
): Promise<void> {
  const env = injectedEnv ?? loadRuntimeEnvironment();
  await withRuntimeEnvironment(env, async () => {
    const config = loadRootConfig("push:last", currentRuntimeEnvironment());
    const db = await getClient();
    const data = databaseData(
      "digests.fetchLatest",
      await db
        .from("digests")
        .select("digest_date, rendered_md, top5_item_ids")
        .order("digest_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (data === null) {
      console.log("数据库里还没有 digest，先跑一次 `npm run ingest`。");
      return;
    }
    assertDatabaseIntegrity(
      "digests.fetchLatest",
      typeof data === "object" &&
        !Array.isArray(data) &&
        isDateKey(data.digest_date) &&
        typeof data.rendered_md === "string" &&
        data.rendered_md.trim().length > 0 &&
        Array.isArray(data.top5_item_ids) &&
        data.top5_item_ids.length >= 1 &&
        data.top5_item_ids.length <= 5 &&
        data.top5_item_ids.every(
          (itemId) => typeof itemId === "string" && /^[0-9a-f-]{36}$/.test(itemId),
        ),
    );
    assertDigestFeedbackLinks(
      data.digest_date as string,
      data.top5_item_ids as string[],
      data.rendered_md as string,
      config.feedback as NonNullable<typeof config.feedback>,
      now,
    );
    const report = await replayDigest(
      `前沿论文情报台 · ${data.digest_date} · Top5`,
      data.rendered_md,
    );
    if (report.succeeded.length) {
      console.log(`已实际投递 ${data.digest_date}：${report.succeeded.join(",")} ✉️`);
    }
    if (report.retried.length) {
      console.log(`${data.digest_date} 暂未送达，已保留重试：${report.retried.join(",")}`);
    }
    if (!report.attempted) {
      console.log(`${data.digest_date} 没有可立即重推的任务；它可能已成功或仍在等待重试。`);
    }
  });
}

export async function runSendLastEntry(
  baseEnv: RuntimeEnvironment = process.env,
): Promise<void> {
  let env: RuntimeEnvironment | undefined;
  try {
    env = loadRuntimeEnvironment({ baseEnv });
    await runSendLastCommand(env);
  } catch (error) {
    console.error(`send failed: ${safeErrorMessage(error, env ?? baseEnv)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runSendLastEntry();
}
