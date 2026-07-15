"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { privateFetch } from "@/lib/private-fetch";
import {
  isAnnotationAnchor,
  isVersionedAnchor,
  locateAnchoredQuote,
  toPixelPoint,
  toPixelRect,
  type AnnotationType,
  type Point,
  type Rect,
} from "@/lib/annotation-anchor";

interface Anno {
  anchor: unknown;
  body: string | null;
  color: string;
  id: string;
  type: AnnotationType;
}
type Tool = "select" | "highlight" | "note" | "pen" | "box" | "erase";

const COLORS = ["#e0c060", "#8a3324", "#5a7d5a", "#4a6a8a"];
const MAX_PEN_POINTS = 512;
const TOOLS: { id: Tool; label: string }[] = [
  { id: "select", label: "选" },
  { id: "highlight", label: "高亮" },
  { id: "note", label: "便签" },
  { id: "pen", label: "画笔" },
  { id: "box", label: "框选" },
  { id: "erase", label: "擦" },
];
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnnotation(value: unknown): value is Anno {
  if (!isRecord(value) || !isRecord(value.anchor)) return false;
  if (
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
    typeof value.color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(value.color) ||
    (value.body !== null && typeof value.body !== "string")
  ) {
    return false;
  }
  return (
    value.type === "note" ||
    value.type === "box" ||
    value.type === "highlight" ||
    value.type === "pen"
  ) &&
    isAnnotationAnchor(value.type, value.anchor);
}

function anchorRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textRange(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | undefined;
  let endNode: Text | undefined;
  let startOffset = 0;
  let endOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const nextOffset = offset + text.length;
    if (!startNode && start >= offset && start <= nextOffset) {
      startNode = node as Text;
      startOffset = start - offset;
    }
    if (end >= offset && end <= nextOffset) {
      endNode = node as Text;
      endOffset = end - offset;
      break;
    }
    offset = nextOffset;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

export default function AnnotatedReader({
  paperId,
  initial,
  children,
  contentVersion = "legacy",
}: {
  paperId: string;
  initial: Anno[];
  children: ReactNode;
  contentVersion?: string;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [annos, setAnnos] = useState<Anno[]>(initial);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Anno | null>(null);
  const [reanchoredHighlights, setReanchoredHighlights] = useState<
    ReadonlyMap<string, readonly Rect[] | null>
  >(new Map());
  const [mutationError, setMutationError] = useState<"save" | "delete" | null>(null);
  const [deletesInFlight, setDeletesInFlight] = useState<ReadonlySet<string>>(new Set());
  const drawing = useRef<{ type: "pen" | "box"; pts: [number, number][]; sx: number; sy: number } | null>(null);
  const supportsVersionedAnchors = /^[a-f0-9]{64}$/.test(contentVersion);

  function withVersion<T extends object>(
    anchor: T,
  ): T | (T & { contentVersion: string; v: 2 }) {
    return supportsVersionedAnchors
      ? { ...anchor, contentVersion, v: 2 as const }
      : anchor;
  }

  function normalizePoint(point: Point): Point {
    const bounded = (value: number) => Number(value.toFixed(6));
    return {
      x: bounded(dims.w > 0 ? Math.min(1, Math.max(0, point.x / dims.w)) : 0),
      y: bounded(dims.h > 0 ? Math.min(1, Math.max(0, point.y / dims.h)) : 0),
    };
  }

  function normalizeRect(value: Rect): Rect {
    const origin = normalizePoint(value);
    return {
      ...origin,
      h: dims.h > 0 ? Math.min(1 - origin.y, Math.max(0, value.h / dims.h)) : 0,
      w: dims.w > 0 ? Math.min(1 - origin.x, Math.max(0, value.w / dims.w)) : 0,
    };
  }

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

  useEffect(() => {
    const sheet = sheetRef.current;
    const content = contentRef.current;
    if (!sheet || !content) return;
    const text = content.textContent ?? "";
    const sheetBounds = sheet.getBoundingClientRect();
    const next = new Map<string, readonly Rect[] | null>();
    for (const annotation of annos) {
      if (annotation.type !== "highlight" || !isVersionedAnchor(annotation.anchor)) continue;
      const anchor = anchorRecord(annotation.anchor);
      if (
        typeof anchor.quote !== "string" ||
        typeof anchor.prefix !== "string" ||
        typeof anchor.suffix !== "string"
      ) {
        next.set(annotation.id, null);
        continue;
      }
      const located = locateAnchoredQuote(text, {
        contentVersion: annotation.anchor.contentVersion,
        prefix: anchor.prefix,
        quote: anchor.quote,
        suffix: anchor.suffix,
        v: 2,
      });
      if (!located) {
        next.set(annotation.id, null);
        continue;
      }
      const range = textRange(content, located.start, located.end);
      if (!range) {
        next.set(annotation.id, null);
        continue;
      }
      const rects = Array.from(range.getClientRects()).map((rect) => ({
        h: rect.height,
        w: rect.width,
        x: rect.left - sheetBounds.left,
        y: rect.top - sheetBounds.top,
      }));
      next.set(annotation.id, rects.length > 0 ? rects : null);
    }
    setReanchoredHighlights(next);
  }, [annos, contentVersion, dims.h, dims.w]);

  async function create(type: AnnotationType, anchor: unknown, body: string | null = null) {
    setMutationError(null);
    try {
      const res = await privateFetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: paperId, type, anchor, color, body }),
      });
      if (!res.ok) throw new Error("annotation save failed");
      const created: unknown = await res.json();
      if (!isAnnotation(created)) throw new Error("invalid annotation response");
      setAnnos((m) => [...m, created]);
    } catch {
      setMutationError("save");
    }
  }
  async function remove(id: string) {
    if (deletesInFlight.has(id)) return;
    setDeletesInFlight((current) => new Set(current).add(id));
    setMutationError(null);
    try {
      const response = await privateFetch(`/api/annotations?id=${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("annotation delete failed");
      const payload = (await response.json()) as { ok?: unknown };
      if (payload.ok !== true) throw new Error("invalid annotation delete response");
      setAnnos((m) => m.filter((a) => a.id !== id));
    } catch {
      setMutationError("delete");
    } finally {
      setDeletesInFlight((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = sheetRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // 高亮：新批注保存归一化几何、精确引文和上下文；旧像素批注仍可读取。
  useEffect(() => {
    function onUp() {
      if (tool !== "highlight") return;
      const sel = window.getSelection();
      const sheet = sheetRef.current;
      const content = contentRef.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sheet || !content) return;
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return;
      const before = document.createRange();
      before.selectNodeContents(content);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const fullText = content.textContent ?? "";
      const selectedLength = sel.toString().length;
      const quote = fullText.slice(start, start + Math.min(selectedLength, 1_000));
      const clippedRange = selectedLength > quote.length
        ? textRange(content, start, start + quote.length)
        : range;
      if (!clippedRange) return;
      const r = sheet.getBoundingClientRect();
      const rects = Array.from(clippedRange.getClientRects()).map((rc) => ({
        x: rc.left - r.left,
        y: rc.top - r.top,
        w: rc.width,
        h: rc.height,
      }));
      if (rects.length && quote) {
        if (supportsVersionedAnchors) {
          void create("highlight", withVersion({
            prefix: fullText.slice(Math.max(0, start - 128), start),
            quote,
            rects: rects.map(normalizeRect),
            suffix: fullText.slice(start + quote.length, start + quote.length + 128),
          }), quote);
        } else {
          void create("highlight", { rects }, quote);
        }
      }
      sel.removeAllRanges();
    }
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, color, contentVersion, dims.h, dims.w, paperId]);

  function onPointerDown(e: React.PointerEvent) {
    const { x, y } = rel(e);
    if (tool === "note") {
      const body = window.prompt("便签内容");
      if (body) {
        const anchor = supportsVersionedAnchors
          ? withVersion(normalizePoint({ x, y }))
          : { x, y };
        void create("note", anchor, body);
      }
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
      if (d.pts.length < MAX_PEN_POINTS) d.pts.push([x, y]);
      else d.pts[MAX_PEN_POINTS - 1] = [x, y];
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
    if (d.type === "pen" && d.pts.length > 1) {
      const anchor = supportsVersionedAnchors
        ? withVersion({
            points: d.pts.map(([x, y]) => {
              const point = normalizePoint({ x, y });
              return [point.x, point.y] as [number, number];
            }),
          })
        : { points: d.pts };
      void create("pen", anchor);
    }
    const draftAnchor = anchorRecord(dr?.anchor);
    const draftRect = {
      h: finiteNumber(draftAnchor.h),
      w: finiteNumber(draftAnchor.w),
      x: finiteNumber(draftAnchor.x),
      y: finiteNumber(draftAnchor.y),
    };
    if (d.type === "box" && dr && draftRect.w > 4 && draftRect.h > 4) {
      const anchor = supportsVersionedAnchors
        ? withVersion(normalizeRect(draftRect))
        : draftRect;
      void create("box", anchor);
    }
  }

  const drawMode = tool === "pen" || tool === "box" || tool === "note" || tool === "erase";

  function shape(a: Anno) {
    const erasable = tool === "erase";
    const pe = erasable ? "auto" : "none";
    const onClick = erasable ? () => remove(a.id) : undefined;
    const cursor = erasable ? "pointer" : "default";
    const anchor = anchorRecord(a.anchor);
    const isVersioned = isVersionedAnchor(anchor);
    const isStaleGeometry = isVersioned && anchor.contentVersion !== contentVersion;
    const dimensions = { h: dims.h, w: dims.w };
    if (a.type === "highlight") {
      const savedRects = Array.isArray(anchor.rects)
        ? anchor.rects.map((value) => {
            const candidate = anchorRecord(value);
            return {
              h: finiteNumber(candidate.h),
              w: finiteNumber(candidate.w),
              x: finiteNumber(candidate.x),
              y: finiteNumber(candidate.y),
            };
          })
        : [];
      const rects = isVersioned
        ? (reanchoredHighlights.has(a.id) ? reanchoredHighlights.get(a.id) ?? [] : [])
        : savedRects;
      return rects.map((rc, i) => (
        <rect key={a.id + i} x={rc.x} y={rc.y} width={rc.w} height={rc.h} fill={a.color} opacity={0.32}
          style={{ pointerEvents: pe, cursor }} onClick={onClick} />
      ));
    }
    if (isStaleGeometry) return null;
    if (a.type === "box") {
      const stored = {
        h: finiteNumber(anchor.h),
        w: finiteNumber(anchor.w),
        x: finiteNumber(anchor.x),
        y: finiteNumber(anchor.y),
      };
      const rect = isVersioned ? toPixelRect(stored, dimensions) : stored;
      return <rect key={a.id} x={rect.x} y={rect.y} width={rect.w} height={rect.h}
        fill="none" stroke={a.color} strokeWidth={2} style={{ pointerEvents: pe, cursor }} onClick={onClick} />;
    }
    if (a.type === "pen") {
      const points = Array.isArray(anchor.points)
        ? anchor.points.filter((point): point is [number, number] =>
            Array.isArray(point) && point.length === 2 &&
            typeof point[0] === "number" && typeof point[1] === "number")
          .map(([x, y]) => isVersioned
            ? toPixelPoint({ x, y }, dimensions)
            : { x, y })
        : [];
      return <polyline key={a.id} points={points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none" stroke={a.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round"
        style={{ pointerEvents: pe, cursor }} onClick={onClick} />;
    }
    return null;
  }

  function notePosition(annotation: Anno): Point {
    const anchor = anchorRecord(annotation.anchor);
    const stored = { x: finiteNumber(anchor.x), y: finiteNumber(anchor.y) };
    return isVersionedAnchor(anchor)
      ? toPixelPoint(stored, { h: dims.h, w: dims.w })
      : stored;
  }

  function isStaleNonHighlight(annotation: Anno): boolean {
    return annotation.type !== "highlight" &&
      isVersionedAnchor(annotation.anchor) &&
      annotation.anchor.contentVersion !== contentVersion;
  }

  const hiddenStaleCount = annos.filter((annotation) => {
    if (!isVersionedAnchor(annotation.anchor) ||
      annotation.anchor.contentVersion === contentVersion) return false;
    return annotation.type === "highlight"
      ? reanchoredHighlights.get(annotation.id) === null
      : true;
  }).length;
  const hiddenAmbiguousCount = annos.filter((annotation) =>
    annotation.type === "highlight" &&
    isVersionedAnchor(annotation.anchor) &&
    annotation.anchor.contentVersion === contentVersion &&
    reanchoredHighlights.get(annotation.id) === null
  ).length;

  return (
    <>
      <div className="anno-toolbar" role="toolbar" aria-label="阅读批注与导出工具">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tool === t.id ? "on" : ""}
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
          >
            {t.label}
          </button>
        ))}
        <span className="tb-sep" />
        {COLORS.map((c) => (
          <button key={c} type="button" className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }}
            onClick={() => setColor(c)} aria-label={`批注颜色 ${c}`} aria-pressed={color === c} />
        ))}
        <span className="tb-sep" />
        <a href={`/api/export/${paperId}?format=md`} aria-label="导出 Markdown">MD</a>
        <a href={`/api/export/${paperId}?format=docx`} aria-label="导出 Word">Word</a>
        <button type="button" onClick={() => window.print()} title="使用浏览器打印为 PDF">PDF</button>
        {mutationError ? (
          <span role="alert" aria-live="assertive" className="tele-stub">
            {mutationError === "save" ? "批注保存失败，请重试" : "批注删除失败，请重试"}
          </span>
        ) : null}
        {hiddenStaleCount > 0 ? (
          <span role="status" className="tele-stub">
            {hiddenStaleCount} 个旧版本批注已隐藏
          </span>
        ) : null}
        {hiddenAmbiguousCount > 0 ? (
          <span role="status" className="tele-stub">
            {hiddenAmbiguousCount} 个无法唯一定位的批注已隐藏
          </span>
        ) : null}
      </div>

      <article className="sheet" ref={sheetRef} data-tool={tool} aria-label="论文阅读与批注区域">
        <div ref={contentRef} style={{ display: "contents" }}>{children}</div>
        <svg
          className="anno-svg"
          width={dims.w}
          height={dims.h}
          style={{ pointerEvents: drawMode ? "auto" : "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-hidden="true"
          focusable="false"
        >
          {annos.map(shape)}
          {draft && shape(draft)}
        </svg>
        {annos
          .filter((a) => a.type === "note" && !isStaleNonHighlight(a))
          .map((a) => {
            const position = notePosition(a);
            return (
              <button
                key={a.id}
                type="button"
                className="anno-note"
                style={{ left: position.x, top: position.y, borderColor: a.color }}
                title={a.body ?? ""}
                onClick={() => (tool === "erase" ? remove(a.id) : window.alert(a.body ?? ""))}
                aria-label={tool === "erase" ? "删除便签批注" : `查看便签：${a.body ?? "空便签"}`}
              >
                ✎
              </button>
            );
          })}
      </article>
    </>
  );
}
