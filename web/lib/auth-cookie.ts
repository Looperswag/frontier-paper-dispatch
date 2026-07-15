import type { CookieOptions } from "@supabase/ssr";

export function authCookieOptions(url: URL): CookieOptions {
  return Object.freeze({
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: url.protocol === "https:",
  });
}

export function authStorageKey(projectURL: string): string {
  return `sb-${new URL(projectURL).hostname.split(".")[0]}-auth-token`;
}
