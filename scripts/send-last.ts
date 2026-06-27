// 只重发"已存在数据库里的最新 digest" —— 调邮件配置时免去重跑采集+DeepSeek。
import { getClient } from "../lib/supabase.ts";
import { sendDigestEmail } from "./digest.ts";

async function main() {
  const db = await getClient();
  const { data, error } = await db
    .from("digests")
    .select("digest_date, rendered_md")
    .order("digest_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.rendered_md) {
    console.log("数据库里还没有 digest，先跑一次 `npm run ingest`。");
    return;
  }
  await sendDigestEmail(`前沿论文情报台 · ${data.digest_date} · Top5`, data.rendered_md);
  console.log(`已重发 ${data.digest_date} 的 digest ✉️`);
}

main().catch((e) => {
  console.error("发送失败：", e);
  process.exit(1);
});
