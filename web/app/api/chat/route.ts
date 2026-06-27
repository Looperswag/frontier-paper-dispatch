import { getPaper, getChats, saveChat, type ChatMsg } from "@/lib/data";
import { deepseek, CHAT_MODEL } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 历史对话
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("itemId");
  return Response.json({ chats: id ? await getChats(id) : [] });
}

// 基于本篇论文的满上下文问答，流式返回纯文本；两端落库到 chats。
export async function POST(req: Request) {
  const { itemId, message, history } = (await req.json()) as {
    itemId?: string;
    message?: string;
    history?: ChatMsg[];
  };
  if (!itemId || !message?.trim()) return new Response("bad request", { status: 400 });

  const paper = await getPaper(itemId);
  if (!paper) return new Response("not found", { status: 404 });

  const ctx = [
    `标题：${paper.title}`,
    `来源：${paper.source} · ${paper.url}`,
    paper.authors?.length ? `作者：${paper.authors.join(", ")}` : "",
    `\n摘要：\n${paper.abstract}`,
    paper.summary?.summary_md ? `\n概要：\n${paper.summary.summary_md}` : "",
    paper.summary?.impact_md ? `\n对用户的影响：\n${paper.summary.impact_md}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    `你是嵌在「前沿论文情报台」阅读器里的助手。用户正在读下面这篇论文/项目，` +
    `请主要基于这份资料并结合你的知识回答；资料未覆盖的内容要说明属推测。务实、简洁、中文为主、专有名词保留英文。\n\n=== 资料 ===\n${ctx}`;

  await saveChat(itemId, "user", message);

  const completion = await deepseek().chat.completions.create({
    model: CHAT_MODEL,
    stream: true,
    max_tokens: 1500,
    messages: [
      { role: "system", content: system },
      ...(history ?? [])
        .filter((h) => h.role === "user" || h.role === "assistant")
        .slice(-8)
        .map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ],
  });

  const encoder = new TextEncoder();
  let full = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of completion) {
          const delta = part.choices[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            controller.enqueue(encoder.encode(delta));
          }
        }
      } finally {
        if (full) await saveChat(itemId, "assistant", full);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
