import {
  createAuthHTTPContext,
  fixedAuthResponse,
  hasSameOrigin,
  withAuthDeadline,
} from "@/lib/auth-http";

export async function POST(request: import("next/server").NextRequest) {
  if (!hasSameOrigin(request)) return fixedAuthResponse("Forbidden", 403);

  let context: ReturnType<typeof createAuthHTTPContext>;
  try {
    context = createAuthHTTPContext(request);
  } catch {
    return fixedAuthResponse("Authentication unavailable", 503);
  }

  let remoteFailure = false;
  try {
    const result = await withAuthDeadline(
      context.client.auth.signOut({ scope: "local" }),
    );
    remoteFailure = result.error !== null;
  } catch {
    remoteFailure = true;
  }

  try {
    await context.clearLocalCookies();
  } catch {
    return context.response("Authentication unavailable", 503);
  }

  if (remoteFailure) return context.response("Authentication unavailable", 503);
  return context.response(null, 303, { Location: "/login" });
}
