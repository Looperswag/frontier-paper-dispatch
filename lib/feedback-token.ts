import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type FeedbackTokenRating = "up" | "down";

export interface FeedbackTokenInput {
  readonly digestDate: string;
  readonly itemId: string;
  readonly rating: FeedbackTokenRating;
}

export interface FeedbackTokenClaims extends FeedbackTokenInput {
  readonly expiresAt: number;
  readonly nonce: string;
  readonly version: "v1";
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_DOMAIN = "frontier-paper-dispatch:feedback:v1";
const NONCE_DOMAIN = "frontier-paper-dispatch:feedback-nonce:v1";
const TOKEN_VALID_DAYS_AFTER_DIGEST = 21;

function validSecret(secret: unknown): secret is string {
  return (
    typeof secret === "string" &&
    Buffer.byteLength(secret, "utf8") >= 32 &&
    ![...secret].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

function validDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || match[1] === "0000") return false;
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return instant.toISOString().slice(0, 10) === value;
}

function validInput(value: FeedbackTokenInput): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    validDateKey(value.digestDate) &&
    CANONICAL_UUID.test(value.itemId) &&
    (value.rating === "up" || value.rating === "down")
  );
}

function expiryForDigest(digestDate: string): number {
  const [year, month, day] = digestDate.split("-").map(Number);
  const shanghaiMidnightUTC = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1_000;
  return Math.floor(
    (shanghaiMidnightUTC + (TOKEN_VALID_DAYS_AFTER_DIGEST + 1) * 24 * 60 * 60 * 1_000) /
      1_000,
  );
}

export function feedbackTokenExpiresAt(digestDate: string): number {
  if (!validDateKey(digestDate)) throw new Error("Invalid feedback digest date");
  const expiresAt = expiryForDigest(digestDate);
  if (parseCanonicalEpochSeconds(String(expiresAt)) === undefined) {
    throw new Error("Invalid feedback digest date");
  }
  return expiresAt;
}

function hmac(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function canonicalBase64URL(value: string): Buffer | undefined {
  if (!BASE64URL_32_BYTES.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : undefined;
}

function equalBase64URL(value: string, expected: Buffer): boolean {
  const decoded = canonicalBase64URL(value);
  const candidate = decoded ?? Buffer.alloc(32);
  const equal = timingSafeEqual(candidate, expected);
  return decoded !== undefined && equal;
}

function nonceFor(secret: string, digestDate: string, itemId: string): Buffer {
  return hmac(secret, `${NONCE_DOMAIN}\0${digestDate}\0${itemId}`);
}

function parseCanonicalEpochSeconds(value: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : undefined;
}

export function issueFeedbackToken(secret: string, input: FeedbackTokenInput): string {
  if (!validSecret(secret)) throw new Error("Invalid feedback token secret");
  if (!validInput(input)) throw new Error("Invalid feedback token claims");
  let expiresAt: number;
  try {
    expiresAt = feedbackTokenExpiresAt(input.digestDate);
  } catch {
    throw new Error("Invalid feedback token claims");
  }
  const nonce = nonceFor(secret, input.digestDate, input.itemId).toString("base64url");
  const payload = [
    "v1",
    input.digestDate,
    input.itemId,
    input.rating,
    String(expiresAt),
    nonce,
  ].join(".");
  const signature = hmac(secret, `${TOKEN_DOMAIN}\0${payload}`).toString("base64url");
  return `${payload}.${signature}`;
}

export function verifyFeedbackToken(
  secret: string,
  token: string,
  now: Date | number = Date.now(),
): FeedbackTokenClaims | undefined {
  if (!validSecret(secret) || typeof token !== "string" || Buffer.byteLength(token) > 256) {
    return undefined;
  }
  const nowMilliseconds = now instanceof Date ? now.valueOf() : now;
  if (!Number.isFinite(nowMilliseconds)) return undefined;
  const parts = token.split(".");
  if (parts.length !== 7) return undefined;
  const [version, digestDate, itemId, rating, expires, nonce, signature] = parts;
  const input = { digestDate, itemId, rating } as FeedbackTokenInput;
  const expiresAt = parseCanonicalEpochSeconds(expires);
  if (version !== "v1" || !validInput(input) || expiresAt === undefined) {
    return undefined;
  }
  const expectedNonce = nonceFor(secret, digestDate, itemId);
  const payload = parts.slice(0, 6).join(".");
  const expectedSignature = hmac(secret, `${TOKEN_DOMAIN}\0${payload}`);
  const nonceMatches = equalBase64URL(nonce, expectedNonce);
  const signatureMatches = equalBase64URL(signature, expectedSignature);
  if (!nonceMatches || !signatureMatches) return undefined;
  if (expiresAt !== expiryForDigest(digestDate) || nowMilliseconds >= expiresAt * 1_000) {
    return undefined;
  }
  return Object.freeze({
    digestDate,
    expiresAt,
    itemId,
    nonce,
    rating: rating as FeedbackTokenRating,
    version: "v1",
  });
}

export function feedbackTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
