import { authorizeAPI } from "@/lib/auth-boundary";
import { ownerWriteRateLimitResponse } from "@/lib/api-rate-limit";
import { hasSameMutationOrigin, readBoundedJSON } from "@/lib/api-request";
import { apiError, apiJSON } from "@/lib/api-response";
import { feedbackRedemptionSchema } from "@/lib/api-schemas";
import { redeemFeedbackToken } from "@/lib/data";
import { verifyFeedbackToken } from "@/lib/sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requestFailure(reason: "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE") {
  if (reason === "PAYLOAD_TOO_LARGE") return apiError(413, reason);
  if (reason === "UNSUPPORTED_MEDIA_TYPE") return apiError(415, reason);
  return apiError(400, reason);
}

function databaseFailure(error: unknown): Response {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "DB_OPERATION_FAILED") return apiError(503, "SERVICE_UNAVAILABLE");
  return apiError(500, "INTERNAL_ERROR");
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  if (!hasSameMutationOrigin(request)) return apiError(403, "CROSS_ORIGIN_REQUEST");
  const rateLimit = await ownerWriteRateLimitResponse(request, authorization.owner);
  if (rateLimit) return rateLimit;

  const body = await readBoundedJSON(request, { maxBytes: 4_096 });
  if (!body.ok) return requestFailure(body.reason);
  const parsed = feedbackRedemptionSchema.safeParse(body.value);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");

  let claims;
  try {
    claims = verifyFeedbackToken(parsed.data.token);
  } catch {
    return apiError(503, "SERVICE_UNAVAILABLE");
  }
  if (!claims) return apiError(410, "TOKEN_INVALID_OR_EXPIRED");

  try {
    const result = await redeemFeedbackToken(authorization.owner, claims);
    if (result.ok) return apiJSON({ ok: true, rating: result.rating });
    if (result.reason === "already_redeemed") {
      return apiError(409, "FEEDBACK_ALREADY_REDEEMED");
    }
    return apiError(410, "TOKEN_INVALID_OR_EXPIRED");
  } catch (error) {
    return databaseFailure(error);
  }
}
