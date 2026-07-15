import "server-only";

import {
  clearAuthCookiesAtScopes,
  createServerClient,
  type CookieOptions,
  type SetAllCookies,
} from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions, authStorageKey } from "@/lib/auth-cookie";
import { getAuthConfig } from "@/lib/config.server";

const MAX_FORM_BYTES = 4096;
const MAX_PASSWORD_BYTES = 1024;
const AUTH_OPERATION_TIMEOUT_MS = 8000;
const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  Expires: "0",
  Pragma: "no-cache",
});

type PendingCookie = { name: string; options: CookieOptions; value: string };

function cookieIdentity(cookie: PendingCookie): string {
  return [cookie.name, cookie.options.domain ?? "", cookie.options.path ?? "/"].join("\u0000");
}

function formContentType(request: NextRequest): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

function declaredBodyTooLarge(request: NextRequest): boolean {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return false;
  if (!/^\d{1,10}$/.test(rawLength)) return true;
  return Number(rawLength) > MAX_FORM_BYTES;
}

async function readBoundedBody(request: NextRequest): Promise<string | undefined> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function withAuthDeadline<T>(operation: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("AUTH_OPERATION_TIMEOUT")),
      AUTH_OPERATION_TIMEOUT_MS,
    );
    void Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function fixedAuthResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit = {},
): NextResponse {
  return new NextResponse(body, {
    headers: { ...NO_STORE_HEADERS, ...Object.fromEntries(new Headers(headers)) },
    status,
  });
}

export function hasSameOrigin(request: NextRequest): boolean {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin || rawOrigin === "null") return false;
  try {
    const origin = new URL(rawOrigin);
    if (rawOrigin !== origin.origin) return false;

    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.trim();
    const protocol =
      forwardedProtocol === "http" || forwardedProtocol === "https"
        ? `${forwardedProtocol}:`
        : request.nextUrl.protocol;
    const host = request.headers.get("host");
    if (!host) return origin.origin === request.nextUrl.origin;
    if (host.includes(",") || /[\s/@\\]/.test(host)) return false;
    const candidate = new URL(`${protocol}//${host}`);
    return !candidate.username && !candidate.password && origin.origin === candidate.origin;
  } catch {
    return false;
  }
}

export async function readLoginPassword(request: NextRequest): Promise<string | undefined> {
  if (!formContentType(request) || declaredBodyTooLarge(request)) return undefined;
  const rawBody = await readBoundedBody(request);
  if (rawBody === undefined) return undefined;

  const entries = [...new URLSearchParams(rawBody).entries()];
  if (entries.length !== 1 || entries[0][0] !== "password") return undefined;
  const password = entries[0][1];
  const byteLength = new TextEncoder().encode(password).byteLength;
  return byteLength > 0 && byteLength <= MAX_PASSWORD_BYTES ? password : undefined;
}

export function createAuthHTTPContext(request: NextRequest) {
  const config = getAuthConfig();
  const cookieOptions = authCookieOptions(request.nextUrl);
  const cookieJar = new Map(
    request.cookies.getAll().map(({ name, value }) => [name, { name, value }]),
  );
  const pendingCookies = new Map<string, PendingCookie>();
  const pendingHeaders = new Headers(NO_STORE_HEADERS);

  const authFetch: typeof fetch = async (input, init = {}) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = [request.signal, init.signal].filter(
      (signal): signal is AbortSignal => signal !== null && signal !== undefined,
    );
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const timeout = setTimeout(abort, AUTH_OPERATION_TIMEOUT_MS);
    try {
      return await globalThis.fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  };

  const getAll = () => [...cookieJar.values()];
  const setAll: SetAllCookies = async (cookiesToSet, headers) => {
    for (const cookie of cookiesToSet) {
      if (cookie.options.maxAge === 0) cookieJar.delete(cookie.name);
      else cookieJar.set(cookie.name, { name: cookie.name, value: cookie.value });
      pendingCookies.set(cookieIdentity(cookie), cookie);
    }
    for (const [key, value] of Object.entries(headers)) pendingHeaders.set(key, value);
  };

  const client = createServerClient(config.url, config.publishableKey, {
    cookieOptions,
    cookies: { getAll, setAll },
    global: { fetch: authFetch },
  });

  async function clearLocalCookies(): Promise<void> {
    await clearAuthCookiesAtScopes({
      getAll: () => getAll(),
      scopes: [cookieOptions],
      setAll,
      storageKey: authStorageKey(config.url),
    });
  }

  function response(
    body: BodyInit | null,
    status: number,
    headers: HeadersInit = {},
  ): NextResponse {
    const result = new NextResponse(body, { status });
    for (const [key, value] of pendingHeaders) result.headers.set(key, value);
    for (const [key, value] of new Headers(headers)) result.headers.set(key, value);
    for (const cookie of pendingCookies.values()) {
      result.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return result;
  }

  return Object.freeze({ clearLocalCookies, client, config, response });
}
