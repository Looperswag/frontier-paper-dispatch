export type AnnotationType = "highlight" | "note" | "pen" | "box";

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  h: number;
  w: number;
}

export interface Dimensions {
  h: number;
  w: number;
}

export interface VersionedAnchorBase {
  contentVersion: string;
  v: 2;
}

export interface AnchoredQuote extends VersionedAnchorBase {
  prefix: string;
  quote: string;
  suffix: string;
}

const CONTENT_VERSION = /^[a-f0-9]{64}$/;
const MAX_LEGACY_COORDINATE = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function legacyCoordinate(value: unknown): value is number {
  return finite(value) && Math.abs(value) <= MAX_LEGACY_COORDINATE;
}

function normalized(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function versioned(value: Record<string, unknown>): boolean {
  return value.v === 2 && typeof value.contentVersion === "string" &&
    CONTENT_VERSION.test(value.contentVersion);
}

function point(value: unknown, isNormalized: boolean): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const valid = isNormalized ? normalized : legacyCoordinate;
  return valid(value[0]) && valid(value[1]);
}

function rect(value: unknown, isNormalized: boolean): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  const valid = isNormalized ? normalized : legacyCoordinate;
  return valid(candidate.x) && valid(candidate.y) &&
    valid(candidate.w) && (candidate.w as number) >= 0 &&
    valid(candidate.h) && (candidate.h as number) >= 0 &&
    (!isNormalized ||
      (candidate.x as number) + (candidate.w as number) <= 1.000_001) &&
    (!isNormalized ||
      (candidate.y as number) + (candidate.h as number) <= 1.000_001);
}

function quoteContext(value: Record<string, unknown>): boolean {
  return typeof value.quote === "string" && value.quote.length >= 1 && value.quote.length <= 1_000 &&
    typeof value.prefix === "string" && value.prefix.length <= 128 &&
    typeof value.suffix === "string" && value.suffix.length <= 128;
}

/** Accept legacy pixel anchors for existing data and v2 normalized anchors for new writes. */
export function isAnnotationAnchor(type: AnnotationType, value: unknown): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  const isVersioned = versioned(candidate);
  if (candidate.v !== undefined && !isVersioned) return false;

  if (type === "note") {
    const valid = isVersioned ? normalized : legacyCoordinate;
    return valid(candidate.x) && valid(candidate.y);
  }
  if (type === "box") return rect(candidate, isVersioned);
  if (type === "pen") {
    return Array.isArray(candidate.points) && candidate.points.length >= 2 &&
      candidate.points.length <= 2_048 &&
      candidate.points.every((entry) => point(entry, isVersioned));
  }
  return Array.isArray(candidate.rects) && candidate.rects.length >= 1 &&
    candidate.rects.length <= 256 &&
    candidate.rects.every((entry) => rect(entry, isVersioned)) &&
    (!isVersioned || quoteContext(candidate));
}

export function toPixelPoint(value: Point, dimensions: Dimensions): Point {
  return { x: value.x * dimensions.w, y: value.y * dimensions.h };
}

export function toPixelRect(value: Rect, dimensions: Dimensions): Rect {
  return {
    h: value.h * dimensions.h,
    w: value.w * dimensions.w,
    x: value.x * dimensions.w,
    y: value.y * dimensions.h,
  };
}

/** Locate one exact quote occurrence using bounded surrounding context. */
export function locateAnchoredQuote(
  text: string,
  anchor: AnchoredQuote,
): Readonly<{ end: number; start: number }> | null {
  if (!CONTENT_VERSION.test(anchor.contentVersion) || anchor.v !== 2 ||
    !quoteContext(anchor as unknown as Record<string, unknown>)) return null;
  const matches: number[] = [];
  let offset = 0;
  while (offset <= text.length - anchor.quote.length) {
    const index = text.indexOf(anchor.quote, offset);
    if (index < 0) break;
    const before = text.slice(Math.max(0, index - anchor.prefix.length), index);
    const after = text.slice(
      index + anchor.quote.length,
      index + anchor.quote.length + anchor.suffix.length,
    );
    if (before === anchor.prefix && after === anchor.suffix) matches.push(index);
    // Advance one code unit so overlapping occurrences are also considered.
    // Skipping by quote length would incorrectly treat `aa` in `aaa` as unique.
    offset = index + 1;
  }
  if (matches.length !== 1) return null;
  return Object.freeze({ start: matches[0], end: matches[0] + anchor.quote.length });
}

export function isVersionedAnchor(value: unknown): value is Record<string, unknown> & VersionedAnchorBase {
  const candidate = record(value);
  return candidate !== undefined && versioned(candidate);
}
