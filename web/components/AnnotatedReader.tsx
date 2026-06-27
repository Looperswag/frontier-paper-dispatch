"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type AnnoType = "highlight" | "note" | "pen" | "box";
type Anno = { id: string; type: AnnoType; anchor: any; color: string; body: string | null };
type Tool = "select" | "highlight" | "note" | "pen" | "box" | "erase";

const COLORS = ["#e0c060", "#8a3324", "#5a7d5a", "#4a6a8a"];
const TOOLS: { id: Tool; label: string }[] = [
  { id: "select", label: "选" },
  { id: "highlight", label: "高亮" },
  { id: "note", label: "便签" },
  { id: "pen", label: "画笔" },
  { id: "box", label: "框选" },
  { id: "erase", label: "擦" },
];

export default function AnnotatedReader({
  paperId,
  initial,
  children,
}: {
  paperId: string;
  initial: Anno[];
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const [annos, setAnnos] = useState<Anno[]>(initial);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Anno | null>(null);
  const drawing = useRef<{ type: "pen" | "box"; pts: number[][]; sx: number; sy: number } | null>(null);

  // 量纸张尺寸（含字体加载/回流）→ SVG 覆盖全高
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const measure = () => setDims({ w: el.clientWidth, h: el.scrollHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function create(type: AnnoType, anchor: any, body: string | null = null) {
    const res = await fetch("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: paperId, type, anchor, color, body }),
    });
    if (res.ok) {
      const created = await res.json();
      setAnnos((m) => [...m, created]);
    }
  }
  async function remove(id: string) {
    await fetch(`/api/annotations?id=${id}`, { method: "DELETE" });
    setAnnos((m) => m.filter((a) => a.id !== id));
  }

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = sheetRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // 高亮：监听选区，存选中文本的 client-rects（纸张相对坐标）
  useEffect(() => {
    function onUp() {
      if (tool !== "highlight") return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sheetRef.current) return;
      const range = sel.getRangeAt(0);
      if (!sheetRef.current.contains(range.commonAncestorContainer)) return;
      const r = sheetRef.current.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).map((rc) => ({
        x: rc.left - r.left,
        y: rc.top - r.top,
        w: rc.width,
        h: rc.height,
      }));
      if (rects.length) create("highlight", { rects }, sel.toString().slice(0, 1000));
      sel.removeAllRanges();
    }
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, color]);

  function onPointerDown(e: React.PointerEvent) {
    const { x, y } = rel(e);
    if (tool === "note") {
      const body = window.prompt("便签内容");
      if (body) create("note", { x, y }, body);
      return;
    }
    if (tool === "pen") drawing.current = { type: "pen", pts: [[x, y]], sx: x, sy: y };
    else if (tool === "box") drawing.current = { type: "box", pts: [], sx: x, sy: y };
    else return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drawing.current;
    if (!d) return;
    const { x, y } = rel(e);
    if (d.type === "pen") {
      d.pts.push([x, y]);
      setDraft({ id: "draft", type: "pen", color, body: null, anchor: { points: [...d.pts] } });
    } else {
      setDraft({
        id: "draft",
        type: "box",
        color,
        body: null,
        anchor: { x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) },
      });
    }
  }
  function onPointerUp() {
    const d = drawing.current;
    const dr = draft;
    drawing.current = null;
    setDraft(null);
    if (!d) return;
    if (d.type === "pen" && d.pts.length > 1) create("pen", { points: d.pts });
    if (d.type === "box" && dr && dr.anchor.w > 4 && dr.anchor.h > 4) create("box", dr.anchor);
  }

  const drawMode = tool === "pen" || tool === "box" || tool === "note" || tool === "erase";

  function shape(a: Anno) {
    const erasable = tool === "erase";
    const pe = erasable ? "auto" : "none";
    const onClick = erasable ? () => remove(a.id) : undefined;
    const cursor = erasable ? "pointer" : "default";
    if (a.type === "highlight")
      return (a.anchor.rects ?? []).map((rc: any, i: number) => (
        <rect key={a.id + i} x={rc.x} y={rc.y} width={rc.w} height={rc.h} fill={a.color} opacity={0.32}
          style={{ pointerEvents: pe, cursor }} onClick={onClick} />
      ));
    if (a.type === "box")
      return <rect key={a.id} x={a.anchor.x} y={a.anchor.y} width={a.anchor.w} height={a.anchor.h}
        fill="none" stroke={a.color} strokeWidth={2} style={{ pointerEvents: pe, cursor }} onClick={onClick} />;
    if (a.type === "pen")
      return <polyline key={a.id} points={(a.anchor.points ?? []).map((p: number[]) => p.join(",")).join(" ")}
        fill="none" stroke={a.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round"
        style={{ pointerEvents: pe, cursor }} onClick={onClick} />;
    return null;
  }

  return (
    <>
      <div className="anno-toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
        <span className="tb-sep" />
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }}
            onClick={() => setColor(c)} aria-label={c} />
        ))}
        <span className="tb-sep" />
        <a href={`/api/export/${paperId}?format=md`}>MD</a>
        <a href={`/api/export/${paperId}?format=docx`}>Word</a>
        <button onClick={() => window.print()}>PDF</button>
      </div>

      <article className="sheet" ref={sheetRef} data-tool={tool}>
        {children}
        <svg
          className="anno-svg"
          width={dims.w}
          height={dims.h}
          style={{ pointerEvents: drawMode ? "auto" : "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {annos.map(shape)}
          {draft && shape(draft)}
        </svg>
        {annos
          .filter((a) => a.type === "note")
          .map((a) => (
            <div
              key={a.id}
              className="anno-note"
              style={{ left: a.anchor.x, top: a.anchor.y, borderColor: a.color }}
              title={a.body ?? ""}
              onClick={() => (tool === "erase" ? remove(a.id) : window.alert(a.body ?? ""))}
            >
              ✎
            </div>
          ))}
      </article>
    </>
  );
}
