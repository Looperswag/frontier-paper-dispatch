import "server-only";

import { redirect } from "next/navigation";
import { OwnerAuthError, type OwnerContext } from "@/lib/auth";
import { requireOwner } from "@/lib/auth-session";
import { hardenAPIResponse } from "@/lib/api-response";

type APIAuthorization =
  | Readonly<{ ok: true; owner: OwnerContext }>
  | Readonly<{ ok: false; response: Response }>;

function authResponse(status: 401 | 403 | 503): Response {
  const body =
    status === 401
      ? "Authentication required"
      : status === 403
        ? "Access forbidden"
        : "Authentication unavailable";
  return hardenAPIResponse(new Response(body, {
    headers: {
      "Cache-Control": "private, no-store",
      Expires: "0",
      Pragma: "no-cache",
      Vary: "Cookie",
    },
    status,
  }));
}

export async function authorizeAPI(): Promise<APIAuthorization> {
  try {
    return Object.freeze({ ok: true, owner: await requireOwner() });
  } catch (error) {
    const status = error instanceof OwnerAuthError ? error.status : 503;
    return Object.freeze({ ok: false, response: authResponse(status) });
  }
}

export async function requireOwnerPage(): Promise<OwnerContext> {
  try {
    return await requireOwner();
  } catch (error) {
    if (error instanceof OwnerAuthError && (error.status === 401 || error.status === 403)) {
      redirect("/login");
    }
    throw new Error("Authentication unavailable");
  }
}
