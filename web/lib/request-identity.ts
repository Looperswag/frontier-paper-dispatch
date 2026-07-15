import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const IP_HMAC_DOMAIN = "frontier-paper-dispatch:api-ip:v1\0";

export interface IPFingerprintConfig {
  readonly secret: string;
  readonly secretVersion: number;
}

export interface IdentityRuntime {
  readonly nodeEnv?: string;
  readonly vercel?: string;
}

function unavailable(): never {
  throw new Error("CLIENT_IP_UNAVAILABLE");
}

function validConfig(config: IPFingerprintConfig): boolean {
  return (
    typeof config.secret === "string" &&
    new TextEncoder().encode(config.secret).byteLength >= 32 &&
    !/[\u0000-\u001f\u007f]/.test(config.secret) &&
    Number.isInteger(config.secretVersion) &&
    config.secretVersion >= 1 &&
    config.secretVersion <= 999_999
  );
}

function canonicalIP(raw: string): string {
  if (raw !== raw.trim() || /[\u0000-\u0020\u007f,]/.test(raw)) unavailable();
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version !== 6 || raw.includes("%")) unavailable();
  try {
    const hostname = new URL(`http://[${raw}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) unavailable();
    return hostname.slice(1, -1);
  } catch {
    return unavailable();
  }
}

function trustedClientIP(request: Request, runtime: IdentityRuntime): string {
  if (runtime.vercel === "1") {
    const value = request.headers.get("x-vercel-forwarded-for");
    return value === null ? unavailable() : canonicalIP(value);
  }
  if (runtime.nodeEnv === "production") return unavailable();

  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return unavailable();
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") return "127.0.0.1";
  if (hostname === "[::1]") return "::1";
  return unavailable();
}

export function clientIPFingerprint(
  request: Request,
  config: IPFingerprintConfig,
  runtime: IdentityRuntime = {
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
  },
): string {
  if (!validConfig(config)) return unavailable();
  const ip = trustedClientIP(request, runtime);
  const digest = createHmac("sha256", config.secret)
    .update(IP_HMAC_DOMAIN)
    .update(ip)
    .digest("hex");
  return `v${config.secretVersion}:${digest}`;
}
