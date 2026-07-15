"use client";

const LOGIN_PATH = "/login";

/**
 * Fetch a private same-origin endpoint. A missing session always causes a hard
 * navigation so all in-memory private UI state is discarded; other failures
 * remain with the caller and no request is retried implicitly.
 */
export async function privateFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) globalThis.location.replace(LOGIN_PATH);
  return response;
}
