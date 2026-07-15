export type JSONReadFailure =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE";

export type JSONReadResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; reason: JSONReadFailure }>;

function validJSONContentType(raw: string | null): boolean {
  if (!raw) return false;
  const [mediaType, ...parameters] = raw.split(";").map((value) => value.trim());
  if (mediaType.toLowerCase() !== "application/json") return false;
  if (parameters.length > 1) return false;
  return (
    parameters.length === 0 ||
    /^charset\s*=\s*(?:"utf-8"|utf-8)$/i.test(parameters[0])
  );
}

function declaredLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d{1,10}$/.test(value)) return Number.NaN;
  return Number(value);
}

function withinComplexity(value: unknown, maxDepth: number, maxNodes: number): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 1, value }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop() as { depth: number; value: unknown };
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return false;
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
  return true;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {});
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cancelReader(reader);
      reject(new Error("REQUEST_ABORTED"));
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export function hasSameMutationOrigin(request: Request): boolean {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin || rawOrigin === "null") return false;
  try {
    const origin = new URL(rawOrigin);
    if (rawOrigin !== origin.origin) return false;
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.trim();
    if (
      forwardedProtocol !== undefined &&
      forwardedProtocol !== "http" &&
      forwardedProtocol !== "https"
    ) {
      return false;
    }
    const requestURL = new URL(request.url);
    const host = request.headers.get("host");
    if (!host) return origin.origin === requestURL.origin;
    if (host.includes(",") || /[\s/?#@\\]/.test(host)) return false;
    const expected = new URL(`${forwardedProtocol ?? requestURL.protocol.slice(0, -1)}://${host}`);
    return !expected.username && !expected.password && origin.origin === expected.origin;
  } catch {
    return false;
  }
}

export function exactQuery(
  request: Request,
  allowedKeys: readonly string[],
): Readonly<Record<string, string>> | undefined {
  const allowed = new Set(allowedKeys);
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return Object.freeze(values);
}

export async function readBoundedJSON(
  request: Request,
  options: Readonly<{ maxBytes: number; maxDepth?: number; maxNodes?: number }>,
): Promise<JSONReadResult> {
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (
    !validJSONContentType(request.headers.get("content-type")) ||
    (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity")
  ) {
    return Object.freeze({ ok: false, reason: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const length = declaredLength(request);
  if (Number.isNaN(length) || (length !== undefined && length > options.maxBytes)) {
    return Object.freeze({ ok: false, reason: "PAYLOAD_TOO_LARGE" });
  }
  const body = request.body;
  if (!body) return Object.freeze({ ok: false, reason: "INVALID_REQUEST" });

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, request.signal);
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        cancelReader(reader);
        return Object.freeze({ ok: false, reason: "PAYLOAD_TOO_LARGE" });
      }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    return Object.freeze({ ok: false, reason: "INVALID_REQUEST" });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may keep cancellation pending; the response still fails closed.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(decoded);
    if (!withinComplexity(value, options.maxDepth ?? 6, options.maxNodes ?? 4096)) {
      return Object.freeze({ ok: false, reason: "INVALID_REQUEST" });
    }
    return Object.freeze({ ok: true, value });
  } catch {
    return Object.freeze({ ok: false, reason: "INVALID_REQUEST" });
  }
}
