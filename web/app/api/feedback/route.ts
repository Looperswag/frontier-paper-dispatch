import { saveFeedback } from "@/lib/data";
import { signFeedback, verifyFeedback } from "@/lib/sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(body: string): Response {
  const html =
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>前沿论文情报台</title></head>` +
    `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#bfa276;font-family:ui-monospace,Menlo,monospace;color:#3a2f25">` +
    `<div style="background:#e9dcbe;padding:36px 44px;max-width:360px;text-align:center;` +
    `box-shadow:0 0 0 1px #8a3324,0 0 0 6px #e9dcbe,0 0 0 7px #8a3324,6px 10px 24px rgba(0,0,0,.3)">${body}</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// 微信一键反馈：签名校验，免登录。
export async function GET(req: Request) {
  const u = new URL(req.url);
  const i = u.searchParams.get("i");
  const r = u.searchParams.get("r");
  const t = u.searchParams.get("t");
  if (!i || (r !== "up" && r !== "down") || !t) return page("<p>链接无效。</p>");
  if (!verifyFeedback(i, r, t)) return new Response("invalid token", { status: 403 });
  try {
    await saveFeedback(i, r);
  } catch {
    return page("<p>记录失败，请稍后重试。</p>");
  }
  const other = r === "up" ? "down" : "up";
  const switchUrl = `/api/feedback?i=${i}&r=${other}&t=${signFeedback(i, other)}`;
  return page(
    `<p style="font-size:19px;margin:0 0 6px">已记录 ${r === "up" ? "👍 有用" : "👎 不相关"}</p>` +
      `<p style="color:#6d5c45;font-size:13px;margin:0">明天的 Top5 会更准。</p>` +
      `<p style="margin:18px 0 0"><a href="${switchUrl}" style="color:#8a3324">点错了？改为 ${other === "up" ? "👍 有用" : "👎 不相关"}</a></p>`,
  );
}

// 网页内打分（带理由）。走正常登录；demo 只读会被 middleware 拦成 403。
export async function POST(req: Request) {
  let body: { itemId?: string; rating?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const { itemId, rating, note } = body;
  if (!itemId || (rating !== "up" && rating !== "down")) return new Response("bad request", { status: 400 });
  await saveFeedback(itemId, rating, note ?? null);
  return Response.json({ ok: true });
}
