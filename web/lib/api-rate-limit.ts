import "server-only";

import type { OwnerContext } from "@/lib/auth";
import { apiError, apiRateLimited } from "@/lib/api-response";
import { consumeAPIRateLimit } from "@/lib/quota";

export async function ownerWriteRateLimitResponse(
  request: Request,
  owner: OwnerContext,
): Promise<Response | undefined> {
  try {
    const decision = await consumeAPIRateLimit(request, "owner_write", owner);
    return decision.allowed ? undefined : apiRateLimited(decision.retryAfter);
  } catch {
    return apiError(503, "SERVICE_UNAVAILABLE");
  }
}
