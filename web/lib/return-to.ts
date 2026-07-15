const INTERNAL_ORIGIN = "https://return.invalid";
const CONTROL_CHARACTER = /\p{Cc}/u;
const PERCENT_ESCAPE_RUN = /(?:%[0-9a-f]{2})+/giu;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;
const PRIVATE_ROUTE_PREFIXES = ["/api", "/login", "/_next"] as const;
const MAX_PERCENT_ENCODING_LAYERS = 16;

export const MAX_RETURN_TO_BYTES = 4_096;
export type InternalRouteKind = "api" | "invalid" | "page" | "restricted";

function decodePercentLayer(value: string): string | undefined {
  let invalid = false;
  const decoded = value.replace(PERCENT_ESCAPE_RUN, (escaped) => {
    try {
      return decodeURIComponent(escaped);
    } catch {
      invalid = true;
      return escaped;
    }
  });
  return invalid ? undefined : decoded;
}

function layerRouteKind(value: string): InternalRouteKind {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    CONTROL_CHARACTER.test(value)
  ) {
    return "invalid";
  }

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (
      parsed.origin !== INTERNAL_ORIGIN ||
      parsed.hash ||
      !parsed.pathname.startsWith("/") ||
      parsed.pathname.startsWith("//")
    ) {
      return "invalid";
    }
    const pathname = parsed.pathname.toLowerCase();
    const protectedPrefix = PRIVATE_ROUTE_PREFIXES.find(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (protectedPrefix === "/api") return "api";
    return protectedPrefix ? "restricted" : "page";
  } catch {
    return "invalid";
  }
}

/** Classifies the canonical route reached through every percent-decoding layer. */
export function classifyInternalRoute(value: unknown): InternalRouteKind {
  if (typeof value !== "string") return "invalid";
  if (new TextEncoder().encode(value).byteLength > MAX_RETURN_TO_BYTES) {
    return layerRouteKind(value) === "api" ? "api" : "invalid";
  }

  let layer = value;
  let protectedKind: Extract<InternalRouteKind, "api" | "restricted"> | undefined;
  for (let remaining = MAX_PERCENT_ENCODING_LAYERS; remaining > 0; remaining -= 1) {
    const kind = layerRouteKind(layer);
    if (kind === "api") protectedKind = "api";
    else if (kind === "restricted" && protectedKind === undefined) protectedKind = "restricted";
    else if (kind === "invalid") return protectedKind ?? "invalid";

    // A valid outer escape can reveal a malformed inner escape, so this check
    // intentionally runs on every decoded layer.
    if (INVALID_PERCENT_ESCAPE.test(layer)) return protectedKind ?? "invalid";
    const decoded = decodePercentLayer(layer);
    if (decoded === undefined) return protectedKind ?? "invalid";
    if (decoded === layer) return protectedKind ?? "page";
    layer = decoded;
  }
  return protectedKind ?? "invalid";
}

/**
 * Returns one bounded, same-origin page path with its query, or the fixed home
 * fallback. Every caller must treat the returned value as the only navigation
 * target; the login API deliberately never receives a redirect parameter.
 */
export function normalizeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (new TextEncoder().encode(value).byteLength > MAX_RETURN_TO_BYTES) return "/";
  return classifyInternalRoute(value) === "page" ? value : "/";
}
