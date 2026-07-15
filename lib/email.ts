import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { loadOptionalSMTPConfig, type SMTPConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment, type RuntimeEnvironment } from "./runtime-env.ts";

const SMTP_TIMEOUT_MS = 30_000;

export interface EmailDeliveryMessage {
  readonly subject: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface EmailDeliveryResult {
  readonly messageId: string;
}

export type EmailFailureClass = "retryable" | "permanent";

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function messageId(key: string, host: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
  const domain = host.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 120) || "localhost";
  return `<frontier-${digest}@${domain}>`;
}

export function classifyEmailFailure(error: unknown): EmailFailureClass {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error
    ? Number((error as { responseCode?: unknown }).responseCode)
    : NaN;
  if (
    ["ECONNECTION", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ESOCKET"].includes(code) ||
    responseCode === 421 ||
    responseCode === 450 ||
    responseCode === 451 ||
    responseCode === 452
  ) return "retryable";
  return "permanent";
}

export function emailTransportOptions(config: SMTPConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  };
}

export async function sendEmail(
  message: EmailDeliveryMessage,
  environment: RuntimeEnvironment = currentRuntimeEnvironment(),
): Promise<EmailDeliveryResult> {
  const config = loadOptionalSMTPConfig(environment);
  if (!config) throw new Error("SMTP delivery is not configured");
  const transport = nodemailer.createTransport(emailTransportOptions(config));
  const id = messageId(message.idempotencyKey, config.host);
  try {
    await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: message.subject.slice(0, 200),
      text: message.text,
      html: `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${htmlEscape(message.text)}</pre>`,
      messageId: id,
      headers: { "X-Frontier-Idempotency-Key": message.idempotencyKey },
    });
    return { messageId: id };
  } finally {
    transport.close();
  }
}
