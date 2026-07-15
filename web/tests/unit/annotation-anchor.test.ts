import { describe, expect, test } from "vitest";
import {
  isAnnotationAnchor,
  locateAnchoredQuote,
  toPixelPoint,
  toPixelRect,
} from "@/lib/annotation-anchor";

const contentVersion = "a".repeat(64);

describe("versioned annotation anchors", () => {
  test("accepts bounded normalized geometry and rejects pixel-like v2 coordinates", () => {
    expect(isAnnotationAnchor("note", { contentVersion, v: 2, x: 0.25, y: 0.75 })).toBe(true);
    expect(isAnnotationAnchor("box", {
      contentVersion,
      h: 0.3,
      v: 2,
      w: 0.2,
      x: 0.1,
      y: 0.4,
    })).toBe(true);
    expect(isAnnotationAnchor("note", { contentVersion, v: 2, x: 20, y: 30 })).toBe(false);
    expect(toPixelPoint({ x: 0.25, y: 0.75 }, { h: 400, w: 800 })).toEqual({ x: 200, y: 300 });
    expect(toPixelRect({ h: 0.3, w: 0.2, x: 0.1, y: 0.4 }, { h: 400, w: 800 }))
      .toEqual({ h: 120, w: 160, x: 80, y: 160 });
  });

  test("re-anchors a quote with prefix and suffix after surrounding content changes", () => {
    const text = "new heading\nEarlier context Alpha target quote Omega trailing text";
    expect(locateAnchoredQuote(text, {
      contentVersion,
      prefix: "context Alpha ",
      quote: "target quote",
      suffix: " Omega trailing",
      v: 2,
    })).toEqual({ end: 46, start: 34 });
  });

  test("fails closed when repeated text cannot be disambiguated", () => {
    expect(locateAnchoredQuote("same phrase / same phrase", {
      contentVersion,
      prefix: "",
      quote: "same phrase",
      suffix: "",
      v: 2,
    })).toBeNull();
  });

  test("detects overlapping quote occurrences as ambiguous", () => {
    expect(locateAnchoredQuote("aaa", {
      contentVersion,
      prefix: "",
      quote: "aa",
      suffix: "",
      v: 2,
    })).toBeNull();
  });
});
