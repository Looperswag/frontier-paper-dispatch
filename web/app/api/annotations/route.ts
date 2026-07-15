import { authorizeAPI } from "@/lib/auth-boundary";
import { ownerWriteRateLimitResponse } from "@/lib/api-rate-limit";
import { exactQuery, hasSameMutationOrigin, readBoundedJSON } from "@/lib/api-request";
import { apiError, apiJSON } from "@/lib/api-response";
import {
  annotationDeleteQuerySchema,
  annotationListQuerySchema,
  annotationMutationSchema,
} from "@/lib/api-schemas";
import { addAnnotation, deleteAnnotation, getAnnotations } from "@/lib/data";

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

export async function GET(request: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  const parsed = annotationListQuerySchema.safeParse(exactQuery(request, ["itemId"]));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");
  try {
    return apiJSON({
      annotations: await getAnnotations(authorization.owner, parsed.data.itemId),
    });
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  if (!hasSameMutationOrigin(request)) return apiError(403, "CROSS_ORIGIN_REQUEST");
  const rateLimit = await ownerWriteRateLimitResponse(request, authorization.owner);
  if (rateLimit) return rateLimit;
  const body = await readBoundedJSON(request, { maxBytes: 32_768 });
  if (!body.ok) return requestFailure(body.reason);
  const parsed = annotationMutationSchema.safeParse(body.value);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");

  const { anchor, body: note, color, itemId, type } = parsed.data;
  try {
    return apiJSON(
      await addAnnotation(authorization.owner, itemId, type, anchor, color, note),
      201,
    );
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeAPI();
  if (!authorization.ok) return authorization.response;
  if (!hasSameMutationOrigin(request)) return apiError(403, "CROSS_ORIGIN_REQUEST");
  const rateLimit = await ownerWriteRateLimitResponse(request, authorization.owner);
  if (rateLimit) return rateLimit;
  const parsed = annotationDeleteQuerySchema.safeParse(exactQuery(request, ["id"]));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST");
  try {
    await deleteAnnotation(authorization.owner, parsed.data.id);
    return apiJSON({ ok: true });
  } catch (error) {
    return databaseFailure(error);
  }
}
