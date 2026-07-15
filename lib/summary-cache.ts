import { getClient } from "./supabase.ts";
import { assertDatabaseIntegrity, databaseData, isDatabaseUuid } from "./db-result.ts";

export interface SummaryCacheValue {
  readonly oneLiner: string;
  readonly summaryMd: string;
  readonly impactMd: string;
  readonly model: string;
}

const HASH = /^[0-9a-f]{64}$/;

function validateKey(itemId: string, contentHash: string, profileHash: string, promptVersion: string): void {
  assertDatabaseIntegrity(
    "summary-cache.key",
    isDatabaseUuid(itemId) && HASH.test(contentHash) && HASH.test(profileHash) && /^[\x20-\x7e]{1,64}$/.test(promptVersion),
  );
}

function value(record: Record<string, unknown>): SummaryCacheValue {
  assertDatabaseIntegrity(
    "summary-cache.value",
    typeof record.one_liner === "string" &&
      record.one_liner.length > 0 &&
      Buffer.byteLength(record.one_liner, "utf8") <= 240 &&
      typeof record.summary_md === "string" &&
      record.summary_md.length > 0 &&
      Buffer.byteLength(record.summary_md, "utf8") <= 16_384 &&
      typeof record.impact_md === "string" &&
      record.impact_md.length > 0 &&
      Buffer.byteLength(record.impact_md, "utf8") <= 16_384 &&
      typeof record.model === "string" &&
      record.model.length > 0 &&
      Buffer.byteLength(record.model, "utf8") <= 100,
  );
  return {
    oneLiner: record.one_liner as string,
    summaryMd: record.summary_md as string,
    impactMd: record.impact_md as string,
    model: record.model as string,
  };
}

export async function getSummaryVersion(
  itemId: string,
  contentHash: string,
  profileHash: string,
  promptVersion: string,
): Promise<SummaryCacheValue | undefined> {
  validateKey(itemId, contentHash, profileHash, promptVersion);
  const db = await getClient();
  const data = databaseData(
    "summary-cache.get",
    await db.rpc("get_summary_version", {
      p_content_hash: contentHash,
      p_item_id: itemId,
      p_profile_hash: profileHash,
      p_prompt_version: promptVersion,
    }),
  );
  assertDatabaseIntegrity("summary-cache.get", Array.isArray(data) && data.length <= 1);
  if (data.length === 0) return undefined;
  return value(data[0] as Record<string, unknown>);
}

export async function storeSummaryVersion(
  itemId: string,
  contentHash: string,
  profileHash: string,
  promptVersion: string,
  summary: SummaryCacheValue,
): Promise<void> {
  validateKey(itemId, contentHash, profileHash, promptVersion);
  const db = await getClient();
  const data = databaseData(
    "summary-cache.store",
    await db.rpc("store_summary_version", {
      p_content_hash: contentHash,
      p_impact_md: summary.impactMd,
      p_item_id: itemId,
      p_model: summary.model,
      p_one_liner: summary.oneLiner,
      p_profile_hash: profileHash,
      p_prompt_version: promptVersion,
      p_summary_md: summary.summaryMd,
    }),
  );
  assertDatabaseIntegrity(
    "summary-cache.store",
    Array.isArray(data) && data.length === 1 && typeof (data[0] as Record<string, unknown>).stored === "boolean",
  );
}
