import { getAnnotations, addAnnotation, deleteAnnotation, type AnnoType } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: AnnoType[] = ["highlight", "note", "pen", "box"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("itemId");
  return Response.json({ annotations: id ? await getAnnotations(id) : [] });
}

export async function POST(req: Request) {
  let body: { itemId?: string; type?: AnnoType; anchor?: unknown; color?: string; body?: string | null };
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const { itemId, type, anchor, color } = body;
  if (!itemId || !type || !TYPES.includes(type) || anchor == null) {
    return new Response("bad request", { status: 400 });
  }
  if (color && !COLOR_RE.test(color)) return new Response("bad color", { status: 400 });
  // 防滥用：anchor 体积上限 + 便签正文上限
  if (JSON.stringify(anchor).length > 20_000) return new Response("anchor too large", { status: 413 });
  const note = typeof body.body === "string" ? body.body.slice(0, 1000) : null;

  const created = await addAnnotation(itemId, type, anchor, color ?? "#e0c060", note);
  return Response.json(created);
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("bad request", { status: 400 });
  await deleteAnnotation(id);
  return Response.json({ ok: true });
}
