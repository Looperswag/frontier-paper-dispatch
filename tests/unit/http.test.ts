import { describe, expect, test, vi } from "vitest";
import { HttpRequestError, httpJSON, httpText } from "../../lib/http.ts";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function queueFetch(...outcomes: Array<Response | Error>): { fetch: typeof fetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("unexpected fetch call");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { fetch: mock as unknown as typeof fetch, mock };
}

describe("httpJSON", () => {
  test("sets provider headers and validates parsed data", async () => {
    const queued = queueFetch(jsonResponse({ items: [1] }));
    const validate = vi.fn((value: unknown) => {
      if (!value || typeof value !== "object" || !("items" in value)) throw new Error("missing items");
      return value as { items: number[] };
    });

    await expect(
      httpJSON("https://example.com/data?token=secret", { fetchImpl: queued.fetch, validate }),
    ).resolves.toEqual({ items: [1] });

    const [, init] = queued.mock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init.headers).get("User-Agent")).toMatch(/^frontier-papers\//);
    expect(validate).toHaveBeenCalledOnce();
  });

  test("allows callers handling untrusted links to reject redirects", async () => {
    const queued = queueFetch(jsonResponse({ ok: true }));
    await httpJSON("https://example.com/data", { fetchImpl: queued.fetch, redirect: "error" });
    const [, init] = queued.mock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });

  test("does not retry a deterministic 404", async () => {
    const queued = queueFetch(new Response("missing", { status: 404 }));
    const sleep = vi.fn();

    const promise = httpJSON("https://example.com/missing?token=must-not-leak", {
      fetchImpl: queued.fetch,
      maxAttempts: 3,
      sleep,
    });
    await expect(promise).rejects.toMatchObject({ attempts: 1, retryable: false, status: 404 });
    await expect(promise).rejects.not.toThrow(/must-not-leak/);
    expect(queued.mock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test.each([401, 403])("does not retry deterministic auth status %i", async (status) => {
    const queued = queueFetch(new Response("denied", { status }));

    await expect(
      httpJSON("https://example.com/auth", {
        fetchImpl: queued.fetch,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ attempts: 1, retryable: false, status });
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("retries HTTP 408", async () => {
    const queued = queueFetch(new Response("timeout", { status: 408 }), jsonResponse({ ok: true }));

    await expect(
      httpJSON("https://example.com/request-timeout", {
        fetchImpl: queued.fetch,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ ok: true });
    expect(queued.mock).toHaveBeenCalledTimes(2);
  });

  test("retries 429 and honors Retry-After seconds", async () => {
    const queued = queueFetch(
      new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
      jsonResponse({ ok: true }),
    );
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await expect(
      httpJSON("https://example.com/rate-limited", {
        fetchImpl: queued.fetch,
        maxAttempts: 3,
        onRetry,
        sleep,
      }),
    ).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 2_000, status: 429 }));
  });

  test("honors an HTTP-date Retry-After value", async () => {
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    const queued = queueFetch(
      new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "Fri, 10 Jul 2026 00:00:05 GMT" },
      }),
      jsonResponse({ ok: true }),
    );
    const sleep = vi.fn(async () => undefined);

    await httpJSON("https://example.com/date-retry", {
      fetchImpl: queued.fetch,
      now: () => now,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  test("uses bounded exponential jitter for retryable 5xx responses", async () => {
    const queued = queueFetch(
      new Response("unavailable", { status: 503 }),
      new Response("error", { status: 500 }),
      jsonResponse({ ok: true }),
    );
    const sleep = vi.fn(async () => undefined);

    await httpJSON("https://example.com/flaky", {
      baseDelayMs: 500,
      fetchImpl: queued.fetch,
      maxAttempts: 3,
      random: () => 0.5,
      sleep,
    });

    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  test("retries a network failure and reports exhaustion explicitly", async () => {
    const queued = queueFetch(new TypeError("socket reset"), new TypeError("socket reset"));

    await expect(
      httpJSON("https://example.com/network", {
        fetchImpl: queued.fetch,
        maxAttempts: 2,
        random: () => 0.5,
        sleep: async () => undefined,
      }),
    ).rejects.toEqual(expect.objectContaining({ attempts: 2, retryable: true }));
  });

  test("retries a response-body network failure", async () => {
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection terminated"));
      },
    });
    const queued = queueFetch(
      new Response(brokenBody, { headers: { "Content-Type": "application/json" } }),
      jsonResponse({ ok: true }),
    );

    await expect(
      httpJSON("https://example.com/broken-stream", {
        fetchImpl: queued.fetch,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ ok: true });
    expect(queued.mock).toHaveBeenCalledTimes(2);
  });

  test("preserves the actual attempt count for invalid data after a retry", async () => {
    const queued = queueFetch(
      new Response("unavailable", { status: 503 }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    );

    await expect(
      httpJSON("https://example.com/invalid-after-retry", {
        fetchImpl: queued.fetch,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ attempts: 2, retryable: false, status: 200 });
  });

  test("does not retry an abort requested by the caller", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.reject(init?.signal?.reason ?? new DOMException("cancelled", "AbortError")),
    ) as unknown as typeof fetch;
    const sleep = vi.fn();

    await expect(
      httpJSON("https://example.com/cancelled", { fetchImpl, signal: controller.signal, sleep }),
    ).rejects.toMatchObject({ attempts: 1, retryable: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  test("does not sleep past the overall deadline", async () => {
    const queued = queueFetch(new Response("unavailable", { status: 503 }));
    const sleep = vi.fn();

    await expect(
      httpJSON("https://example.com/deadline", {
        baseDelayMs: 500,
        deadlineMs: 100,
        fetchImpl: queued.fetch,
        random: () => 0.5,
        sleep,
      }),
    ).rejects.toThrow(/deadline exhausted/i);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries a response body that hangs until the per-attempt timeout", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const outcome = await Promise.race([
      httpJSON("https://example.com/hanging-body", {
        baseDelayMs: 0,
        deadlineMs: 100,
        fetchImpl,
        maxAttempts: 2,
        sleep: async () => undefined,
        timeoutMs: 5,
      }).catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).toMatchObject({ attempts: 2, retryable: true, status: 200 });
    expect(String(outcome)).toMatch(/retry budget exhausted/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("caller abort interrupts response-body reading", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5);

    const outcome = await Promise.race([
      httpJSON("https://example.com/abort-body", {
        fetchImpl,
        maxAttempts: 1,
        signal: controller.signal,
      }).catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).toMatchObject({ attempts: 1, retryable: false });
    expect(String(outcome)).toMatch(/aborted by caller/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("caller abort interrupts backoff before another fetch", async () => {
    const controller = new AbortController();
    const queued = queueFetch(new Response("unavailable", { status: 503 }), jsonResponse({ ok: true }));
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5);

    await expect(
      httpJSON("https://example.com/abort-backoff", {
        fetchImpl: queued.fetch,
        signal: controller.signal,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 30)),
      }),
    ).rejects.toMatchObject({ attempts: 1, retryable: false });
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("clears the default backoff timer when the caller aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const queued = queueFetch(new Response("unavailable", { status: 503 }), jsonResponse({ ok: true }));
      const promise = httpJSON("https://example.com/abort-default-backoff", {
        baseDelayMs: 30_000,
        fetchImpl: queued.fetch,
        onRetry: () => setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 5),
        signal: controller.signal,
      });
      const rejection = expect(promise).rejects.toMatchObject({ attempts: 1, retryable: false });

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a caller abort triggered synchronously by onRetry cannot hang in backoff", async () => {
    const controller = new AbortController();
    const queued = queueFetch(new Response("unavailable", { status: 503 }), jsonResponse({ ok: true }));

    const outcome = await Promise.race([
      httpJSON("https://example.com/synchronous-backoff-abort", {
        fetchImpl: queued.fetch,
        onRetry: () => controller.abort(new DOMException("cancelled", "AbortError")),
        signal: controller.signal,
        sleep: () => new Promise(() => undefined),
      }).catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ attempts: 1, retryable: false });
    expect(String(outcome)).toMatch(/aborted by caller/i);
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("a synchronous abort inside sleep wins over its resolved promise", async () => {
    const controller = new AbortController();
    const queued = queueFetch(new Response("unavailable", { status: 503 }), jsonResponse({ ok: true }));

    await expect(
      httpJSON("https://example.com/synchronous-sleep-abort", {
        fetchImpl: queued.fetch,
        signal: controller.signal,
        sleep: async () => {
          controller.abort(new DOMException("cancelled", "AbortError"));
        },
      }),
    ).rejects.toMatchObject({ attempts: 1, retryable: false });
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("does not retain a transport cause that contains a secret query", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("failed https://example.com/data?token=transport-secret");
    }) as unknown as typeof fetch;

    const error = await httpJSON("https://example.com/data?token=request-secret", {
      fetchImpl,
      maxAttempts: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpRequestError);
    expect(String(error)).not.toMatch(/request-secret|transport-secret/);
    expect(String((error as Error & { cause?: unknown }).cause ?? "")).not.toMatch(
      /request-secret|transport-secret/,
    );
  });

  test("rejects an invalid URL before fetching or retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("invalid URL");
    }) as unknown as typeof fetch;

    await expect(
      httpJSON("not a URL", {
        fetchImpl,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ attempts: 0, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects URL credentials before fetching or retrying", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    await expect(
      httpJSON("https://user:password@example.com/data", {
        fetchImpl,
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ attempts: 0, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("turns an invalid header into a sanitized non-retryable error and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
      const promise = httpJSON("https://example.com/invalid-header", {
        fetchImpl,
        headers: { "bad header": "secret-value" },
        timeoutMs: 30_000,
      });

      await expect(promise).rejects.toMatchObject({ attempts: 1, retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports retry-budget exhaustion with the final HTTP status", async () => {
    const queued = queueFetch(
      new Response("unavailable", { status: 503 }),
      new Response("unavailable", { status: 503 }),
      new Response("unavailable", { status: 503 }),
    );

    const error = await httpJSON("https://example.com/exhausted", {
      fetchImpl: queued.fetch,
      maxAttempts: 3,
      sleep: async () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ attempts: 3, retryable: true, status: 503 });
    expect(String(error)).toMatch(/retry budget exhausted/i);
    expect(queued.mock).toHaveBeenCalledTimes(3);
  });

  test("stops streaming once the decoded-body byte limit is exceeded", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("1234"));
        if (pulls === 100) controller.close();
      },
    });
    const queued = queueFetch(new Response(body, { headers: { "Content-Type": "application/json" } }));

    await expect(
      httpJSON("https://example.com/stream-limit", {
        fetchImpl: queued.fetch,
        maxResponseBytes: 5,
      }),
    ).rejects.toThrow(/large/i);
    expect(pulls).toBeLessThan(100);
    expect(cancel).toHaveBeenCalled();
  });

  test("does not wait forever for cancellation of a non-2xx body", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise(() => undefined),
      start(controller) {
        controller.enqueue(new TextEncoder().encode("unavailable"));
      },
    });
    const queued = queueFetch(new Response(body, { status: 503 }));

    const outcome = await Promise.race([
      httpJSON("https://example.com/hanging-error-cancel", {
        fetchImpl: queued.fetch,
        maxAttempts: 1,
        timeoutMs: 5,
      }).catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ attempts: 1, retryable: true, status: 503 });
  });

  test.each([
    ["an unexpected content type", { "Content-Type": "text/html" }, 100],
    ["an oversized declared body", { "Content-Length": "200", "Content-Type": "application/json" }, 100],
  ])("cancels a body rejected for %s", async (_name, headers, maxResponseBytes) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
    });
    const queued = queueFetch(new Response(body, { headers }));

    await expect(
      httpJSON("https://example.com/rejected-body", {
        fetchImpl: queued.fetch,
        maxResponseBytes,
      }),
    ).rejects.toBeInstanceOf(HttpRequestError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("bounds jitter at both ends and caps exponential delay", async () => {
    const queued = queueFetch(
      new Response("unavailable", { status: 503 }),
      new Response("unavailable", { status: 503 }),
      jsonResponse({ ok: true }),
    );
    const randomValues = [0, 1];
    const sleep = vi.fn(async () => undefined);

    await httpJSON("https://example.com/jitter-bounds", {
      baseDelayMs: 500,
      fetchImpl: queued.fetch,
      maxDelayMs: 600,
      random: () => randomValues.shift() ?? 0.5,
      sleep,
    });

    expect(sleep.mock.calls).toEqual([[250], [600]]);
  });

  test.each([
    ["wrong content type", new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } }), /content-type/i],
    ["empty body", new Response("", { headers: { "Content-Type": "application/json" } }), /empty/i],
    ["malformed JSON", new Response("{", { headers: { "Content-Type": "application/json" } }), /json/i],
    [
      "oversized content length",
      new Response("{}", { headers: { "Content-Length": "200", "Content-Type": "application/json" } }),
      /large/i,
    ],
  ])("rejects a 200 response with %s without retry", async (_name, response, message) => {
    const queued = queueFetch(response);

    await expect(
      httpJSON("https://example.com/bad-data?secret=value", {
        fetchImpl: queued.fetch,
        maxAttempts: 3,
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow(message);
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("rejects a semantic validator failure without retry", async () => {
    const queued = queueFetch(jsonResponse({ fallback: true }));

    await expect(
      httpJSON("https://example.com/fallback", {
        fetchImpl: queued.fetch,
        maxAttempts: 3,
        validate: () => {
          throw new Error("missing required items");
        },
      }),
    ).rejects.toThrow(/validation.*missing required items/i);
    expect(queued.mock).toHaveBeenCalledOnce();
  });

  test("aborts an attempt at its timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    ) as unknown as typeof fetch;

    await expect(
      httpJSON("https://example.com/hang", { fetchImpl, maxAttempts: 1, timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(HttpRequestError);
  });
});

describe("httpText", () => {
  test("accepts XML media types and rejects oversized decoded bodies", async () => {
    const valid = queueFetch(
      new Response("<rss><channel /></rss>", { headers: { "Content-Type": "application/rss+xml" } }),
    );
    await expect(httpText("https://example.com/feed", { fetchImpl: valid.fetch })).resolves.toContain("<rss>");

    const oversized = queueFetch(
      new Response("论文论文", { headers: { "Content-Type": "application/xml" } }),
    );
    await expect(
      httpText("https://example.com/large", { fetchImpl: oversized.fetch, maxResponseBytes: 6 }),
    ).rejects.toThrow(/large/i);
  });
});
