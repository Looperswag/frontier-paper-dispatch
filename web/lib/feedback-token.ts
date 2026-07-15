import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type FeedbackTokenRating = "up" | "down";

export interface FeedbackTokenClaims {
  readonly digestDate: string;
  readonly expiresAt: number;
  readonly itemId: string;
  readonly nonce: string;
  readonly rating: FeedbackTokenRating;
  readonly version: "v1";
}

declare const verifiedFeedbackTokenBrand: unique symbol;

/** An HMAC-verified capability. Only this module can create a valid instance. */
export type VerifiedFeedbackTokenClaims = FeedbackTokenClaims & {
  readonly [verifiedFeedbackTokenBrand]: true;
};

const verifiedClaims = new WeakSet<object>();

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_DOMAIN = "frontier-paper-dispatch:feedback:v1";
const NONCE_DOMAIN = "frontier-paper-dispatch:feedback-nonce:v1";

function validDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || match[1] === "0000") return false;
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return instant.toISOString().slice(0, 10) === value;
}

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

function expiryForDigest(digestDate: string): number {
  const [year, month, day] = digestDate.split("-").map(Number);
  return Math.floor(
    (Date.UTC(year, month - 1, day) -
      8 * 60 * 60 * 1_000 +
      22 * 24 * 60 * 60 * 1_000) /
      1_000,
  );
}

function hmac(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function canonicalBase64URL(value: string): Buffer | undefined {
  if (!BASE64URL_32_BYTES.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : undefined;
}

function secureEqual(value: string, expected: Buffer): boolean {
  const decoded = canonicalBase64URL(value);
  const candidate = decoded ?? Buffer.alloc(32);
  const equal = timingSafeEqual(candidate, expected);
  return decoded !== undefined && equal;
}

function parseCanonicalEpochSeconds(value: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : undefined;
}

export function verifyFeedbackToken(
  secret: string,
  token: string,
  now: Date | number = Date.now(),
): VerifiedFeedbackTokenClaims | undefined {
  if (!validSecret(secret) || typeof token !== "string" || Buffer.byteLength(token) > 256) {
    return undefined;
  }
  const nowMilliseconds = now instanceof Date ? now.valueOf() : now;
  if (!Number.isFinite(nowMilliseconds)) return undefined;
  const parts = token.split(".");
  if (parts.length !== 7) return undefined;
  const [version, digestDate, itemId, rating, expires, nonce, signature] = parts;
  const expiresAt = parseCanonicalEpochSeconds(expires);
  if (
    version !== "v1" ||
    !validDateKey(digestDate) ||
    !CANONICAL_UUID.test(itemId) ||
    (rating !== "up" && rating !== "down") ||
    expiresAt === undefined ||
    !BASE64URL_32_BYTES.test(nonce)
  ) {
    return undefined;
  }
  const expectedNonce = hmac(
    secret,
    `${NONCE_DOMAIN}\0${digestDate}\0${itemId}`,
  );
  const expectedSignature = hmac(
    secret,
    `${TOKEN_DOMAIN}\0${parts.slice(0, 6).join(".")}`,
  );
  const nonceMatches = secureEqual(nonce, expectedNonce);
  const signatureMatches = secureEqual(signature, expectedSignature);
  if (!nonceMatches || !signatureMatches) return undefined;
  if (expiresAt !== expiryForDigest(digestDate) || nowMilliseconds >= expiresAt * 1_000) {
    return undefined;
  }
  const claims: FeedbackTokenClaims = {
    digestDate,
    expiresAt,
    itemId,
    nonce,
    rating,
    version: "v1",
  };
  verifiedClaims.add(claims);
  return Object.freeze(claims) as VerifiedFeedbackTokenClaims;
}

/** Runtime complement to the opaque type; structural clones are not capabilities. */
export function isVerifiedFeedbackTokenClaims(
  value: unknown,
): value is VerifiedFeedbackTokenClaims {
  return value !== null && typeof value === "object" && verifiedClaims.has(value);
}

export function feedbackTokenFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
