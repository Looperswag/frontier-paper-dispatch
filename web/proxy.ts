import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieOptions } from "@/lib/auth-cookie";
import { hardenAPIResponse } from "@/lib/api-response";
import { classifyInternalRoute, normalizeReturnTo } from "@/lib/return-to";
import {
  loadWebRuntimeConfig,
  resolveAccessMode,
  WebConfigError,
  type AccessMode,
  type WebRuntimeConfig,
} from "@/lib/runtime-config";

type AuthConfig = NonNullable<WebRuntimeConfig["auth"]>;
type AuthDecision = "authenticated" | "unauthenticated" | "unavailable";
const AUTH_OPERATION_TIMEOUT_MS = 8_000;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_ERROR_CODES = new Set([
  "bad_jwt",
  "invalid_jwt",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
  "unexpected_audience",
  "user_not_found",
]);

function publicAuthRequest(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (pathname === "/login") return request.method === "GET" || request.method === "HEAD";
  return (
    request.method === "POST" &&
    (pathname === "/api/auth/login" || pathname === "/api/auth/logout")
  );
}

function noStore(response: NextResponse, noReferrer = false): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  if (noReferrer) response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, noarchive");
  const vary = response.headers.get("Vary");
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "cookie")) {
    response.headers.set("Vary", vary ? `${vary}, Cookie` : "Cookie");
  }
  hardenAPIResponse(response);
  return response;
}

function unavailable(): NextResponse {
  return noStore(new NextResponse("Authentication unavailable", { status: 503 }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentialFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "AuthSessionMissingError" || error.status === 401) return true;
  return typeof error.code === "string" && CREDENTIAL_ERROR_CODES.has(error.code);
}

function authDecision(result: unknown): AuthDecision {
  if (!isRecord(result) || !("data" in result) || !("error" in result)) {
    return "unavailable";
  }
  if (result.error !== null) {
    return credentialFailure(result.error) ? "unauthenticated" : "unavailable";
  }
  if (result.data === null) return "unauthenticated";
  if (!isRecord(result.data) || !("claims" in result.data)) return "unavailable";
  const claims = result.data.claims;
  if (claims === null) return "unauthenticated";
  if (
    !isRecord(claims) ||
    typeof claims.sub !== "string" ||
    !CANONICAL_UUID.test(claims.sub) ||
    claims.role !== "authenticated" ||
    claims.is_anonymous === true
  ) {
    return "unavailable";
  }
  return "authenticated";
}

function unauthenticated(request: NextRequest, loginBaseURL?: string): NextResponse {
  const routeKind = classifyInternalRoute(request.nextUrl.pathname);
  if (routeKind === "api" || routeKind === "invalid") {
    return noStore(new NextResponse("Authentication required", { status: 401 }));
  }
  const loginURL = new URL("/login", loginBaseURL ?? request.nextUrl.origin);
  loginURL.searchParams.set(
    "returnTo",
    normalizeReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`),
  );
  return noStore(NextResponse.redirect(loginURL), true);
}

function settleWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("AUTH_OPERATION_ABORTED"));
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function refreshAuthSession(
  request: NextRequest,
  config: AuthConfig,
  loginBaseURL?: string,
): Promise<NextResponse> {
  const cookieMutations: Array<{
    name: string;
    options: Record<string, unknown>;
    value: string;
  }> = [];
  const authHeaders = new Headers();
  const operationController = new AbortController();
  const abortOperation = () => operationController.abort();
  if (request.signal.aborted) abortOperation();
  else request.signal.addEventListener("abort", abortOperation, { once: true });
  const timeout = setTimeout(abortOperation, AUTH_OPERATION_TIMEOUT_MS);
  const authFetch: typeof fetch = async (input, init = {}) => {
    const transportController = new AbortController();
    const abortTransport = () => transportController.abort();
    const signals = [operationController.signal, init.signal].filter(
      (signal): signal is AbortSignal => signal !== null && signal !== undefined,
    );
    for (const signal of signals) {
      if (signal.aborted) abortTransport();
      else signal.addEventListener("abort", abortTransport, { once: true });
    }
    try {
      return await globalThis.fetch(input, { ...init, signal: transportController.signal });
    } finally {
      for (const signal of signals) signal.removeEventListener("abort", abortTransport);
    }
  };
  let decision: AuthDecision;
  try {
    const client = createServerClient(config.url, config.publishableKey, {
      cookieOptions: authCookieOptions(request.nextUrl),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, options, value }) => {
            request.cookies.set(name, value);
            cookieMutations.push({ name, options, value });
          });
          Object.entries(headers).forEach(([key, value]) => authHeaders.set(key, value));
        },
      },
      global: { fetch: authFetch },
    });
    decision = authDecision(
      await settleWithAbort(client.auth.getClaims(), operationController.signal),
    );
  } catch {
    decision = "unavailable";
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortOperation);
  }
  const response =
    decision === "authenticated"
      ? NextResponse.next({ request })
      : decision === "unauthenticated"
        ? unauthenticated(request, loginBaseURL)
        : unavailable();
  for (const [key, value] of authHeaders) response.headers.set(key, value);
  for (const { name, options, value } of cookieMutations) {
    response.cookies.set(name, value, options);
  }
  return noStore(response);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let access: AccessMode;
  let authConfig: AuthConfig | undefined;
  let loginBaseURL: string | undefined;
  try {
    if (process.env.NODE_ENV === "production") {
      const runtimeConfig = loadWebRuntimeConfig("production", process.env, {
        hostname: request.nextUrl.hostname,
      });
      access = runtimeConfig.access as AccessMode;
      authConfig = runtimeConfig.auth;
      loginBaseURL = runtimeConfig.feedback?.webBaseURL;
    } else {
      access = resolveAccessMode(process.env, request.nextUrl.hostname);
      if (access.kind === "private") {
        authConfig = loadWebRuntimeConfig("auth", process.env).auth;
      }
    }
  } catch (error) {
    if (error instanceof WebConfigError) return unavailable();
    return unavailable();
  }

  if (access.kind === "local") return noStore(NextResponse.next());

  if (publicAuthRequest(request)) {
    return noStore(NextResponse.next(), request.nextUrl.pathname === "/login");
  }

  if (!authConfig) return unavailable();
  try {
    return await refreshAuthSession(request, authConfig, loginBaseURL);
  } catch {
    return unavailable();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
