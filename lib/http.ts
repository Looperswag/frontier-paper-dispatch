const USER_AGENT = "frontier-papers/0.1 (research digest bot)";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DEADLINE_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type FetchImplementation = typeof fetch;
type HttpRedirectMode = "error" | "follow" | "manual";

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  error: unknown;
  status?: number;
}

export interface HttpOptions {
  baseDelayMs?: number;
  deadlineMs?: number;
  fetchImpl?: FetchImplementation;
  headers?: Record<string, string>;
  maxAttempts?: number;
  maxDelayMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  onRetry?: (event: RetryEvent) => void;
  random?: () => number;
  redirect?: HttpRedirectMode;
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}

export interface JSONOptions<T> extends HttpOptions {
  validate?: (value: unknown) => T;
}

export interface BoundedJSONResponseOptions<T> {
  endpoint?: string;
  maxResponseBytes: number;
  signal?: AbortSignal;
  validate: (value: unknown) => T;
}

interface ResolvedOptions {
  baseDelayMs: number;
  deadlineMs: number;
  fetchImpl: FetchImplementation;
  headers?: Record<string, string>;
  maxAttempts: number;
  maxDelayMs: number;
  maxResponseBytes: number;
  now: () => number;
  onRetry?: (event: RetryEvent) => void;
  random: () => number;
  redirect: HttpRedirectMode;
  signal?: AbortSignal;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs: number;
}

interface BodyResult {
  attempts: number;
  body: string;
  status: number;
}

export class HttpRequestError extends Error {
  readonly attempts: number;
  readonly endpoint: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      attempts: number;
      endpoint: string;
      retryable: boolean;
      status?: number;
    },
  ) {
    super(message);
    this.name = "HttpRequestError";
    this.attempts = options.attempts;
    this.endpoint = options.endpoint;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

const defaultSleep = (delayMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Request aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function positiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

function resolveOptions(options: HttpOptions): ResolvedOptions {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError("maxAttempts must be an integer between 1 and 5");
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError("baseDelayMs must be a non-negative number");
  }
  return {
    baseDelayMs,
    deadlineMs: positiveNumber("deadlineMs", options.deadlineMs ?? DEFAULT_DEADLINE_MS),
    fetchImpl: options.fetchImpl ?? fetch,
    headers: options.headers,
    maxAttempts,
    maxDelayMs: positiveNumber("maxDelayMs", options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
    maxResponseBytes: positiveNumber(
      "maxResponseBytes",
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    ),
    now: options.now ?? Date.now,
    onRetry: options.onRetry,
    random: options.random ?? Math.random,
    redirect: options.redirect ?? "follow",
    signal: options.signal,
    sleep: options.sleep ?? defaultSleep,
    timeoutMs: positiveNumber("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
}

function safeEndpoint(rawURL: string): string {
  try {
    const url = new URL(rawURL);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function requireHTTPURL(rawURL: string): URL {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw requestError("<invalid-url>", 0, false, "Invalid HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw requestError(`${url.protocol}//<invalid-url>`, 0, false, "Invalid HTTP URL protocol");
  }
  if (url.username || url.password) {
    throw requestError(`${url.origin}${url.pathname}`, 0, false, "HTTP URL credentials are not allowed");
  }
  return url;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryDelay(response: Response | null, attempt: number, options: ResolvedOptions): number {
  const instructed = retryAfterMs(response?.headers.get("Retry-After") ?? null, options.now());
  if (instructed !== null) return Math.min(instructed, options.maxDelayMs);
  const jitter = 0.5 + Math.min(1, Math.max(0, options.random()));
  return Math.min(options.baseDelayMs * 2 ** (attempt - 1) * jitter, options.maxDelayMs);
}

function requestError(
  endpoint: string,
  attempts: number,
  retryable: boolean,
  message: string,
  status?: number,
): HttpRequestError {
  return new HttpRequestError(`${message} (${endpoint})`, {
    attempts,
    endpoint,
    retryable,
    status,
  });
}

function retryBudgetError(error: HttpRequestError, attempts: number): HttpRequestError {
  return requestError(
    error.endpoint,
    attempts,
    true,
    `HTTP retry budget exhausted after ${attempts} attempt(s)`,
    error.status,
  );
}

async function waitBeforeRetry(
  error: HttpRequestError,
  response: Response | null,
  attempt: number,
  startedAt: number,
  options: ResolvedOptions,
): Promise<void> {
  if (options.signal?.aborted) {
    throw requestError(error.endpoint, attempt, false, "HTTP request aborted by caller");
  }
  const delayMs = retryDelay(response, attempt, options);
  const remainingMs = options.deadlineMs - (options.now() - startedAt);
  if (remainingMs <= delayMs) {
    throw requestError(
      error.endpoint,
      attempt,
      true,
      `HTTP deadline exhausted after ${attempt} attempt(s)`,
      error.status,
    );
  }
  options.onRetry?.({ attempt, delayMs, error, status: error.status });
  if (options.signal?.aborted) {
    throw requestError(error.endpoint, attempt, false, "HTTP request aborted by caller");
  }
  if (!options.signal) {
    try {
      await options.sleep(delayMs);
    } catch {
      throw requestError(error.endpoint, attempt, false, "HTTP retry delay failed");
    }
    return;
  }

  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new DOMException("Request aborted", "AbortError"));
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) abortListener();
  });
  try {
    await Promise.race([options.sleep(delayMs, options.signal), aborted]);
    if (options.signal.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
  } catch {
    if (options.signal.aborted) {
      throw requestError(error.endpoint, attempt, false, "HTTP request aborted by caller");
    }
    throw requestError(error.endpoint, attempt, false, "HTTP retry delay failed");
  } finally {
    if (abortListener) options.signal.removeEventListener("abort", abortListener);
  }
}

interface AttemptHandle {
  cleanup: () => void;
  controller: AbortController;
  response: Response;
  timedOut: () => boolean;
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException;
}

async function openAttempt(
  url: string,
  accept: string,
  attempt: number,
  timeoutMs: number,
  options: ResolvedOptions,
): Promise<AttemptHandle> {
  const endpoint = safeEndpoint(url);
  let headers: Headers;
  try {
    headers = new Headers(options.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
    if (!headers.has("Accept")) headers.set("Accept", accept);
  } catch {
    throw requestError(endpoint, attempt, false, "Invalid HTTP request headers");
  }
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    throw requestError(endpoint, attempt, false, "HTTP request aborted by caller");
  }
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  };
  try {
    const response = await options.fetchImpl(url, { headers, redirect: options.redirect, signal: controller.signal });
    return { cleanup, controller, response, timedOut: () => didTimeOut };
  } catch (error) {
    cleanup();
    const callerAborted = options.signal?.aborted ?? false;
    const retryable = !callerAborted && (didTimeOut || isNetworkFailure(error));
    throw requestError(
      endpoint,
      attempt,
      retryable,
      callerAborted
        ? "HTTP request aborted by caller"
        : retryable
          ? "HTTP network request failed"
          : "HTTP fetch failed with a non-network error",
    );
  }
}

function contentType(response: Response): string {
  return (response.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function cancelBody(body: ReadableStream<Uint8Array> | null, reason: string): void {
  if (!body) return;
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // Best-effort cleanup must never mask the request result.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Best-effort cleanup must never mask the request result.
  }
}

async function validatedBody(
  response: Response,
  attempt: number,
  endpoint: string,
  options: ResolvedOptions,
  accepts: (mediaType: string) => boolean,
  signal: AbortSignal,
): Promise<string> {
  const mediaType = contentType(response);
  if (!accepts(mediaType)) {
    cancelBody(response.body, "Unexpected Content-Type");
    throw requestError(
      endpoint,
      attempt,
      false,
      `Unexpected Content-Type ${mediaType || "<missing>"}`,
      response.status,
    );
  }

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > options.maxResponseBytes) {
    cancelBody(response.body, "Response exceeded declared byte limit");
    throw requestError(endpoint, attempt, false, "Response is too large", response.status);
  }

  if (!response.body) {
    throw requestError(endpoint, attempt, false, "Response body is empty", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  for (;;) {
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        queueMicrotask(() => cancelReader(reader, signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
      chunk = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > options.maxResponseBytes) {
      cancelReader(reader, "Response exceeded configured byte limit");
      throw requestError(endpoint, attempt, false, "Response is too large", response.status);
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  if (!body.trim()) {
    throw requestError(endpoint, attempt, false, "Response body is empty", response.status);
  }
  return body;
}

async function requestBody(
  url: string,
  accept: string,
  accepts: (mediaType: string) => boolean,
  inputOptions: HttpOptions,
): Promise<BodyResult> {
  const options = resolveOptions(inputOptions);
  const parsedURL = requireHTTPURL(url);
  const endpoint = `${parsedURL.origin}${parsedURL.pathname}`;
  const startedAt = options.now();

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const remainingMs = options.deadlineMs - (options.now() - startedAt);
    if (remainingMs <= 0) {
      throw requestError(endpoint, attempt - 1, true, "HTTP deadline exhausted");
    }

    let handle: AttemptHandle;
    try {
      handle = await openAttempt(
        url,
        accept,
        attempt,
        Math.max(1, Math.min(options.timeoutMs, remainingMs)),
        options,
      );
    } catch (error) {
      if (!(error instanceof HttpRequestError)) throw error;
      if (!error.retryable) throw error;
      if (attempt === options.maxAttempts) throw retryBudgetError(error, attempt);
      await waitBeforeRetry(error, null, attempt, startedAt, options);
      continue;
    }

    const { response } = handle;
    if (!response.ok) {
      cancelBody(response.body, `HTTP status ${response.status}`);
      handle.cleanup();
      const retryable = isRetryableStatus(response.status);
      const error = requestError(
        endpoint,
        attempt,
        retryable,
        `HTTP request failed with status ${response.status}`,
        response.status,
      );
      if (!retryable) throw error;
      if (attempt === options.maxAttempts) throw retryBudgetError(error, attempt);
      await waitBeforeRetry(error, response, attempt, startedAt, options);
      continue;
    }

    try {
      const result = {
        attempts: attempt,
        body: await validatedBody(
          response,
          attempt,
          endpoint,
          options,
          accepts,
          handle.controller.signal,
        ),
        status: response.status,
      };
      handle.cleanup();
      return result;
    } catch (error) {
      handle.cleanup();
      if (error instanceof HttpRequestError) throw error;
      const callerAborted = options.signal?.aborted ?? false;
      const retryable = !callerAborted && (handle.timedOut() || isNetworkFailure(error));
      const bodyError = requestError(
        endpoint,
        attempt,
        retryable,
        callerAborted
          ? "HTTP request aborted by caller"
          : retryable
            ? "HTTP response body could not be read"
            : "HTTP response body failed with a non-network error",
        response.status,
      );
      if (!retryable) throw bodyError;
      if (attempt === options.maxAttempts) throw retryBudgetError(bodyError, attempt);
      await waitBeforeRetry(bodyError, null, attempt, startedAt, options);
    }
  }

  throw requestError(
    endpoint,
    options.maxAttempts,
    true,
    `HTTP retry budget exhausted after ${options.maxAttempts} attempt(s)`,
  );
}

const acceptsJSON = (mediaType: string): boolean =>
  mediaType === "application/json" || mediaType.endsWith("+json");

const acceptsXML = (mediaType: string): boolean =>
  mediaType === "application/xml" ||
  mediaType === "text/xml" ||
  mediaType === "text/plain" ||
  mediaType.endsWith("+xml");

const acceptsHTML = (mediaType: string): boolean =>
  acceptsXML(mediaType) || mediaType === "text/html" || mediaType === "application/xhtml+xml";

export async function httpText(url: string, options: HttpOptions = {}): Promise<string> {
  const result = await requestBody(
    url,
    "application/xml, text/xml, application/rss+xml, application/atom+xml",
    acceptsXML,
    options,
  );
  return result.body;
}

export async function httpHTML(url: string, options: HttpOptions = {}): Promise<string> {
  const result = await requestBody(
    url,
    "text/html, application/xhtml+xml, application/xml, text/xml",
    acceptsHTML,
    options,
  );
  return result.body;
}

export async function httpJSON<T>(url: string, options: JSONOptions<T> = {}): Promise<T> {
  const result = await requestBody(url, "application/json", acceptsJSON, options);
  let value: unknown;
  try {
    value = JSON.parse(result.body);
  } catch {
    throw requestError(
      safeEndpoint(url),
      result.attempts,
      false,
      "Response is not valid JSON",
      result.status,
    );
  }
  if (!options.validate) return value as T;
  try {
    return options.validate(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw requestError(
      safeEndpoint(url),
      result.attempts,
      false,
      `Response validation failed: ${message}`,
      result.status,
    );
  }
}

/** Parse an already-open response without ever buffering beyond the byte cap. */
export async function readBoundedJSONResponse<T>(
  response: Response,
  options: BoundedJSONResponseOptions<T>,
): Promise<T> {
  const endpoint = options.endpoint ?? "<redacted>";
  if (!/^[-A-Za-z0-9_.:/<>]{1,200}$/.test(endpoint)) {
    throw new TypeError("endpoint label is invalid");
  }
  if (!response.ok) {
    cancelBody(response.body, `HTTP status ${response.status}`);
    throw requestError(
      endpoint,
      1,
      isRetryableStatus(response.status),
      `HTTP request failed with status ${response.status}`,
      response.status,
    );
  }
  const resolved = resolveOptions({
    maxAttempts: 1,
    maxResponseBytes: options.maxResponseBytes,
  });
  const signal = options.signal ?? new AbortController().signal;
  const body = await validatedBody(
    response,
    1,
    endpoint,
    resolved,
    acceptsJSON,
    signal,
  );
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw requestError(endpoint, 1, false, "Response is not valid JSON", response.status);
  }
  try {
    return options.validate(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw requestError(
      endpoint,
      1,
      false,
      `Response validation failed: ${message}`,
      response.status,
    );
  }
}

export const clean = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
