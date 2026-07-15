import { saveFeedback } from "@/lib/data";
import { authorizeAPI } from "@/lib/auth-boundary";
import { ownerWriteRateLimitResponse } from "@/lib/api-rate-limit";
import { hasSameMutationOrigin, readBoundedJSON } from "@/lib/api-request";
import { apiError, apiJSON } from "@/lib/api-response";
import { feedbackMutationSchema } from "@/lib/api-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function databaseFailure(error: unknown): Response {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "DB_NOT_FOUND") return apiError(404, "NOT_FOUND");
  if (code === "DB_OPERATION_FAILED") return apiError(503, "SERVICE_UNAVAILABLE");
  return apiError(500, "INTERNAL_ERROR");
}

function requestFailure(reason: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
  if (reason === "PAYLOAD_TOO_LARGE") return apiError(413, reason);
  if (reason === "UNSUPPORTED_MEDIA_TYPE") return apiError(415, reason);
  return apiError(400, reason);
}

// Deprecated click-to-write links are inert; new links open /feedback first.
export async function GET(request: Request) {
  void request;
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  return apiError(410, "TOKEN_INVALID_OR_EXPIRED");
}

// 网页内打分（带理由）：仅接受已验证 owner 会话。
export async function POST(req: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  if (!hasSameMutationOrigin(req)) return apiError(403, "CROSS_ORIGIN_REQUEST");
  const rateLimit = await ownerWriteRateLimitResponse(req, authorization.owner);
  if (rateLimit) return rateLimit;
  const body = await readBoundedJSON(req, { maxBytes: 4_096 });
  if (!body.ok) return requestFailure(body.reason);
  const parsed = feedbackMutationSchema.safeParse(body.value);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");
  const { itemId, rating, note } = parsed.data;
  try {
    await saveFeedback(authorization.owner, itemId, rating, note);
  } catch (error) {
    return databaseFailure(error);
  }
  return apiJSON({ ok: true });
}
