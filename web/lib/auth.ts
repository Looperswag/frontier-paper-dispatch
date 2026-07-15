import "server-only";

import { normalizeAuthEmail } from "@/lib/runtime-config";

export type OwnerAuthCode =
  | "AUTH_FORBIDDEN"
  | "AUTH_UNAUTHENTICATED"
  | "AUTH_UNAVAILABLE";

declare const OWNER_CONTEXT: unique symbol;
export type OwnerContext = Readonly<{
  email: string;
  userId: string;
  [OWNER_CONTEXT]: true;
}>;

export class OwnerAuthError extends Error {
  readonly code: OwnerAuthCode;
  readonly status: 401 | 403 | 503;

  constructor(code: OwnerAuthCode) {
    const status =
      code === "AUTH_UNAUTHENTICATED" ? 401 : code === "AUTH_FORBIDDEN" ? 403 : 503;
    const message =
      status === 401
        ? "Authentication required"
        : status === 403
          ? "Access forbidden"
          : "Authentication unavailable";
    super(message);
    this.name = "OwnerAuthError";
    this.code = code;
    this.status = status;
  }
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;
const CREDENTIAL_ERROR_CODES = new Set([
  "bad_jwt",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
  "unexpected_audience",
  "user_not_found",
]);
const FORBIDDEN_ERROR_CODES = new Set([
  "email_not_confirmed",
  "provider_email_needs_verification",
  "user_banned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(): never {
  throw new OwnerAuthError("AUTH_UNAVAILABLE");
}

function credentialError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "AuthSessionMissingError" || error.status === 401) return true;
  return typeof error.code === "string" && CREDENTIAL_ERROR_CODES.has(error.code);
}

function forbiddenCredentialError(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    FORBIDDEN_ERROR_CODES.has(error.code)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(AUTH_TIMESTAMP);
  if (!match || match[1].startsWith("0000-")) return false;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) {
    return false;
  }
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value))
  );
}

export function ownerFromAuthResult(result: unknown, configuredOwnerEmail: unknown): OwnerContext {
  const expectedEmail = normalizeAuthEmail(configuredOwnerEmail);
  if (!expectedEmail || !isRecord(result) || !("error" in result)) return unavailable();

  if (result.error !== null) {
    if (credentialError(result.error)) {
      throw new OwnerAuthError("AUTH_UNAUTHENTICATED");
    }
    if (forbiddenCredentialError(result.error)) {
      throw new OwnerAuthError("AUTH_FORBIDDEN");
    }
    return unavailable();
  }

  if (!isRecord(result.data) || !("user" in result.data) || !isRecord(result.data.user)) {
    return unavailable();
  }
  const user = result.data.user;
  if (typeof user.id !== "string" || !CANONICAL_UUID.test(user.id)) return unavailable();
  if (typeof user.is_anonymous !== "boolean" || typeof user.role !== "string") {
    return unavailable();
  }

  const actualEmail = normalizeAuthEmail(user.email);
  if (
    !actualEmail ||
    actualEmail !== expectedEmail ||
    user.is_anonymous ||
    user.role !== "authenticated" ||
    user.email_confirmed_at === undefined ||
    user.email_confirmed_at === null ||
    user.email_confirmed_at === ""
  ) {
    throw new OwnerAuthError("AUTH_FORBIDDEN");
  }
  if (!validTimestamp(user.email_confirmed_at)) return unavailable();

  return Object.freeze({
    email: actualEmail,
    userId: user.id.toLowerCase(),
  }) as OwnerContext;
}
