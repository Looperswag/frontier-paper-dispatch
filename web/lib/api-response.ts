export type APIErrorCode =
  | "ACCESS_FORBIDDEN"
  | "AUTHENTICATION_REQUIRED"
  | "CROSS_ORIGIN_REQUEST"
  | "FEEDBACK_ALREADY_REDEEMED"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "LLM_BUDGET_EXHAUSTED"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "TOKEN_INVALID_OR_EXPIRED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UPSTREAM_UNAVAILABLE";

const ERROR_MESSAGES: Readonly<Record<APIErrorCode, string>> = Object.freeze({
  ACCESS_FORBIDDEN: "Access forbidden",
  AUTHENTICATION_REQUIRED: "Authentication required",
  CROSS_ORIGIN_REQUEST: "Cross-origin request denied",
  FEEDBACK_ALREADY_REDEEMED: "Feedback was already recorded",
  INTERNAL_ERROR: "Internal error",
  INVALID_REQUEST: "Invalid request",
  LLM_BUDGET_EXHAUSTED: "Daily LLM budget exhausted",
  NOT_FOUND: "Resource not found",
  PAYLOAD_TOO_LARGE: "Payload too large",
  RATE_LIMITED: "Too many requests",
  SERVICE_UNAVAILABLE: "Service unavailable",
  TOKEN_INVALID_OR_EXPIRED: "Feedback link is invalid or expired",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
  UPSTREAM_UNAVAILABLE: "Upstream unavailable",
});

export function hardenAPIResponse(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  const values = new Map(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => [value.toLowerCase(), value]),
  );
  values.set("cookie", "Cookie");
  values.set("origin", "Origin");
  response.headers.set("Vary", [...values.values()].join(", "));
  return response;
}

export function apiJSON(data: unknown, status = 200): Response {
  return hardenAPIResponse(Response.json(data, { status }));
}

export function apiError(status: number, code: APIErrorCode): Response {
  return apiJSON(
    Object.freeze({
      error: Object.freeze({ code, message: ERROR_MESSAGES[code] }),
      ok: false,
    }),
    status,
  );
}

function retryableError(
  code: "LLM_BUDGET_EXHAUSTED" | "RATE_LIMITED",
  retryAfter: number,
): Response {
  const boundedRetryAfter =
    Number.isSafeInteger(retryAfter) && retryAfter >= 1
      ? Math.min(retryAfter, 86_400)
      : 1;
  const response = apiError(429, code);
  response.headers.set("Retry-After", String(boundedRetryAfter));
  return response;
}

export function apiRateLimited(retryAfter: number): Response {
  return retryableError("RATE_LIMITED", retryAfter);
}

export function apiLLMBudgetExhausted(retryAfter: number): Response {
  return retryableError("LLM_BUDGET_EXHAUSTED", retryAfter);
}
