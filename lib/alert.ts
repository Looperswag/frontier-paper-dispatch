import { loadOptionalAlertConfig, type AlertConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment } from "./runtime-env.ts";

export interface AlertEvent {
  readonly event: string;
  readonly severity: "warning" | "critical";
  readonly runDate?: string;
  readonly detail: string;
  readonly correlationId?: string;
}

export function alertRequest(event: AlertEvent, config: AlertConfig): RequestInit & { url: string } {
  return {
    url: config.webhookURL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify({ source: "frontier-paper-dispatch", ...event }),
    signal: AbortSignal.timeout(10_000),
  };
}

function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup must not replace the original job outcome or webhook status.
  }
}

/** Failure alert uses a separate webhook and never throws into the main job. */
export async function sendFailureAlert(
  event: AlertEvent,
  environment: Readonly<Record<string, string | undefined>> = currentRuntimeEnvironment(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const config = loadOptionalAlertConfig(environment);
    if (!config) return false;
    const request = alertRequest(event, config);
    const response = await fetchImpl(request.url, request);
    discardResponseBody(response);
    return response.ok;
  } catch {
    return false;
  }
}
