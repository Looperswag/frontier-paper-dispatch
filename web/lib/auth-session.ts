import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import { OwnerAuthError, ownerFromAuthResult, type OwnerContext } from "@/lib/auth";
import { getAuthConfig } from "@/lib/config.server";

async function verifyRequestOwner(): Promise<OwnerContext> {
  try {
    const config = getAuthConfig();
    const cookieStore = await cookies();
    const client = createServerClient(config.url, config.publishableKey, {
      cookies: {
        getAll: () => cookieStore.getAll(),
      },
    });
    const result = await client.auth.getUser();
    return ownerFromAuthResult(result, config.ownerEmail);
  } catch (error) {
    if (error instanceof OwnerAuthError) throw error;
    throw new OwnerAuthError("AUTH_UNAVAILABLE");
  }
}

export const requireOwner = cache(verifyRequestOwner);
