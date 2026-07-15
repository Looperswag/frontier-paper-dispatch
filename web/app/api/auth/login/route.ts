import { OwnerAuthError, ownerFromAuthResult } from "@/lib/auth";
import {
  createAuthHTTPContext,
  fixedAuthResponse,
  hasSameOrigin,
  readLoginPassword,
  withAuthDeadline,
} from "@/lib/auth-http";
import { consumeAPIRateLimit } from "@/lib/quota";

type AuthFailure = Readonly<{ code?: unknown; status?: unknown }>;

function loginFailure(error: AuthFailure): 401 | 429 | 503 {
  if (error.status === 429) return 429;
  if (
    error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.code === "invalid_credentials" ||
    error.code === "email_not_confirmed" ||
    error.code === "user_banned"
  ) {
    return 401;
  }
  return 503;
}

function failureResponse(
  context: ReturnType<typeof createAuthHTTPContext>,
  status: 401 | 429 | 503,
) {
  if (status === 401) return context.response("Authentication failed", 401);
  if (status === 429) {
    return context.response("Authentication temporarily unavailable", 429, {
      "Retry-After": "60",
    });
  }
  return context.response("Authentication unavailable", 503);
}

async function clearRejectedSession(
  context: ReturnType<typeof createAuthHTTPContext>,
): Promise<void> {
  try {
    await withAuthDeadline(context.client.auth.signOut({ scope: "local" }));
  } catch {
    // Local cookie removal below is authoritative for this browser.
  } finally {
    await context.clearLocalCookies();
  }
}

export async function POST(request: import("next/server").NextRequest) {
  if (!hasSameOrigin(request)) return fixedAuthResponse("Forbidden", 403);

  try {
    const decision = await consumeAPIRateLimit(request, "auth_login");
    if (!decision.allowed) {
      return fixedAuthResponse("Authentication temporarily unavailable", 429, {
        "Retry-After": String(decision.retryAfter),
      });
    }
  } catch {
    return fixedAuthResponse("Authentication unavailable", 503);
  }

  let password: string | undefined;
  try {
    password = await readLoginPassword(request);
  } catch {
    return fixedAuthResponse("Invalid request", 400);
  }
  if (password === undefined) return fixedAuthResponse("Invalid request", 400);

  let context: ReturnType<typeof createAuthHTTPContext>;
  try {
    context = createAuthHTTPContext(request);
  } catch {
    return fixedAuthResponse("Authentication unavailable", 503);
  }

  try {
    const signIn = await withAuthDeadline(
      context.client.auth.signInWithPassword({
        email: context.config.ownerEmail,
        password,
      }),
    );
    if (signIn.error) return failureResponse(context, loginFailure(signIn.error));

    try {
      ownerFromAuthResult(
        await withAuthDeadline(context.client.auth.getUser()),
        context.config.ownerEmail,
      );
    } catch (error) {
      await clearRejectedSession(context);
      if (error instanceof OwnerAuthError && error.status !== 503) {
        return failureResponse(context, 401);
      }
      return failureResponse(context, 503);
    }

    return context.response(null, 204);
  } catch {
    return failureResponse(context, 503);
  }
}
