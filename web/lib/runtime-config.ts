export type WebConfigTarget =
  | "auth"
  | "data"
  | "feedback"
  | "llm"
  | "production"
  | "quota";
type Environment = Readonly<Record<string, string | undefined>>;

interface WebConfigIssue {
  code: "CONFLICT" | "FORBIDDEN_PUBLIC_SECRET" | "INVALID" | "MISSING" | "OBSOLETE";
  key: string;
  relatedKey?: string;
}

export class WebConfigError extends Error {
  readonly code = "INVALID_WEB_CONFIG";
  readonly issues: readonly WebConfigIssue[];

  constructor(issues: readonly WebConfigIssue[]) {
    const safeIssues = issues.map((issue) => Object.freeze({ ...issue }));
    super(
      `Web configuration is invalid (${safeIssues
        .map((issue) =>
          `${issue.code}:${issue.key}${issue.relatedKey ? `:${issue.relatedKey}` : ""}`,
        )
        .join(", ")})`,
    );
    this.name = "WebConfigError";
    this.issues = Object.freeze(safeIssues);
  }
}

export type AccessMode =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "private" }>;

export interface WebRuntimeConfig {
  readonly access?: AccessMode;
  readonly auth?: Readonly<{ ownerEmail: string; publishableKey: string; url: string }>;
  readonly deepseek?: Readonly<{ apiKey: string; baseURL: "https://api.deepseek.com" }>;
  readonly feedback?: Readonly<{ secret: string; webBaseURL: string }>;
  readonly quota?: Readonly<{
    secret: string;
    secretVersion: number;
    serviceRoleKey: string;
    url: string;
  }>;
  readonly supabase?: Readonly<{ serviceRoleKey: string; url: string }>;
  readonly target: WebConfigTarget;
}

const FORBIDDEN_PUBLIC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_DEEPSEEK_API_KEY",
  "NEXT_PUBLIC_FEEDBACK_SECRET",
  "NEXT_PUBLIC_APP_PASSWORD",
  "NEXT_PUBLIC_GITHUB_TOKEN",
  "NEXT_PUBLIC_SERVERCHAN_SENDKEY",
  "NEXT_PUBLIC_SERVERCHAN_KEY",
  "NEXT_PUBLIC_LLM_API_KEY",
  "NEXT_PUBLIC_RATE_LIMIT_SECRET",
] as const;

const WEB_CONFIG_TARGETS = new Set<WebConfigTarget>([
  "auth",
  "data",
  "feedback",
  "llm",
  "production",
  "quota",
]);

function valueOf(env: Environment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function placeholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    value.includes("...") ||
    value.includes("<") ||
    normalized.includes("replace-with-") ||
    normalized.includes("replace-me") ||
    /^(?:x{4,}|example|changeme)$/.test(normalized)
  );
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
const validHeaderToken = (value: string): boolean => /^[\x21-\x7e]+$/.test(value);

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validBaseURL(rawURL: string): boolean {
  try {
    if (hasControlCharacter(rawURL)) return false;
    const url = new URL(rawURL);
    if (url.username || url.password || url.hash || url.search) return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    const placeholderHostname = url.hostname
      .split(".")
      .some((label) => /^x{4,}$/i.test(label) || /^(?:your-app|your-project|replace-me)$/i.test(label));
    if (placeholderHostname || placeholder(rawURL)) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));
  } catch {
    return false;
  }
}

function invalidServiceRoleKey(value: string): boolean {
  if (
    value.length < 24 ||
    !validHeaderToken(value) ||
    placeholder(value) ||
    /^sb_publishable_/i.test(value)
  ) {
    return true;
  }
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(value)) return false;
  return jwtRole(value) !== "service_role";
}

function jwtRole(value: string): string | undefined {
  const segments = value.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const encoded = segments[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

function invalidPublishableKey(value: string): boolean {
  if (value.length < 24 || !validHeaderToken(value) || placeholder(value)) return true;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return false;
  return jwtRole(value) !== "anon";
}

function validOwnerEmail(value: string): boolean {
  if (value.length > 254 || hasControlCharacter(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !domain || !domain.includes(".")) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  return domain.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

export function normalizeAuthEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized && validOwnerEmail(normalized) ? normalized : undefined;
}

function accessIssues(env: Environment): WebConfigIssue[] {
  const issues: WebConfigIssue[] = [];
  if (valueOf(env, "APP_PASSWORD")) issues.push({ code: "OBSOLETE", key: "APP_PASSWORD" });
  if (valueOf(env, "NEXT_PUBLIC_DEMO_MODE")) {
    issues.push({ code: "OBSOLETE", key: "NEXT_PUBLIC_DEMO_MODE" });
  }
  return issues;
}

export function resolveAccessMode(env: Environment, hostname: string): AccessMode {
  const issues = accessIssues(env);
  if (issues.length) throw new WebConfigError(issues);
  const production = valueOf(env, "NODE_ENV") === "production";
  return Object.freeze(production || !loopback(hostname) ? { kind: "private" } : { kind: "local" });
}

export function loadWebRuntimeConfig(
  target: WebConfigTarget,
  env: Environment = process.env,
  options: { hostname?: string } = {},
): WebRuntimeConfig {
  if (!WEB_CONFIG_TARGETS.has(target)) {
    throw new WebConfigError([{ code: "INVALID", key: "target" }]);
  }
  const issues: WebConfigIssue[] = [...accessIssues(env)];
  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (valueOf(env, key)) issues.push({ code: "FORBIDDEN_PUBLIC_SECRET", key });
  }

  const supabaseURL = valueOf(env, "SUPABASE_URL");
  const serviceRoleKey = valueOf(env, "SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = valueOf(env, "SUPABASE_PUBLISHABLE_KEY");
  const ownerEmailValue = valueOf(env, "AUTH_OWNER_EMAIL");
  const ownerEmail = normalizeAuthEmail(ownerEmailValue);
  const deepseekKey = valueOf(env, "DEEPSEEK_API_KEY");
  const feedbackSecret = valueOf(env, "FEEDBACK_SECRET");
  const webBaseURL = valueOf(env, "WEB_BASE_URL");
  const rateLimitSecret = valueOf(env, "RATE_LIMIT_SECRET");
  const rateLimitSecretVersionValue = valueOf(env, "RATE_LIMIT_SECRET_VERSION");
  const rateLimitSecretVersion =
    rateLimitSecretVersionValue && /^[1-9][0-9]{0,5}$/.test(rateLimitSecretVersionValue)
      ? Number(rateLimitSecretVersionValue)
      : undefined;

  let access: AccessMode | undefined;
  if (target === "production") {
    void options.hostname;
    access = Object.freeze({ kind: "private" });
  }

  const requireAuth = target === "auth" || target === "production";
  const requireSupabase = target === "data" || target === "production" || target === "quota";
  const requireDeepSeek = target === "llm" || target === "production";
  const requireFeedback = target === "feedback" || target === "production";
  const requireQuota = target === "quota" || target === "production";
  if ((requireSupabase || requireAuth || serviceRoleKey || publishableKey) && !supabaseURL) {
    issues.push({ code: "MISSING", key: "SUPABASE_URL" });
  }
  if (requireSupabase && !serviceRoleKey) {
    issues.push({ code: "MISSING", key: "SUPABASE_SERVICE_ROLE_KEY" });
  }
  if ((requireAuth || publishableKey) && !ownerEmailValue) {
    issues.push({ code: "MISSING", key: "AUTH_OWNER_EMAIL" });
  }
  if ((requireAuth || ownerEmailValue) && !publishableKey) {
    issues.push({ code: "MISSING", key: "SUPABASE_PUBLISHABLE_KEY" });
  }
  if (requireDeepSeek && !deepseekKey) issues.push({ code: "MISSING", key: "DEEPSEEK_API_KEY" });
  if ((requireFeedback || feedbackSecret) && !webBaseURL) {
    issues.push({ code: "MISSING", key: "WEB_BASE_URL" });
  }
  if ((requireFeedback || webBaseURL) && !feedbackSecret) {
    issues.push({ code: "MISSING", key: "FEEDBACK_SECRET" });
  }
  if ((requireQuota || rateLimitSecretVersionValue) && !rateLimitSecret) {
    issues.push({ code: "MISSING", key: "RATE_LIMIT_SECRET" });
  }
  if ((requireQuota || rateLimitSecret) && !rateLimitSecretVersionValue) {
    issues.push({ code: "MISSING", key: "RATE_LIMIT_SECRET_VERSION" });
  }

  if (supabaseURL && !validBaseURL(supabaseURL)) issues.push({ code: "INVALID", key: "SUPABASE_URL" });
  if (serviceRoleKey && invalidServiceRoleKey(serviceRoleKey)) {
    issues.push({ code: "INVALID", key: "SUPABASE_SERVICE_ROLE_KEY" });
  }
  if (ownerEmailValue && !ownerEmail) {
    issues.push({ code: "INVALID", key: "AUTH_OWNER_EMAIL" });
  }
  if (publishableKey && invalidPublishableKey(publishableKey)) {
    issues.push({ code: "INVALID", key: "SUPABASE_PUBLISHABLE_KEY" });
  }
  if (
    deepseekKey &&
    (deepseekKey.length < 16 || !validHeaderToken(deepseekKey) || placeholder(deepseekKey))
  ) {
    issues.push({ code: "INVALID", key: "DEEPSEEK_API_KEY" });
  }
  if (webBaseURL && !validBaseURL(webBaseURL)) issues.push({ code: "INVALID", key: "WEB_BASE_URL" });
  if (
    feedbackSecret &&
    (new TextEncoder().encode(feedbackSecret).byteLength < 32 ||
      hasControlCharacter(feedbackSecret) ||
      placeholder(feedbackSecret))
  ) {
    issues.push({ code: "INVALID", key: "FEEDBACK_SECRET" });
  }
  if (
    rateLimitSecret &&
    (new TextEncoder().encode(rateLimitSecret).byteLength < 32 ||
      hasControlCharacter(rateLimitSecret) ||
      placeholder(rateLimitSecret))
  ) {
    issues.push({ code: "INVALID", key: "RATE_LIMIT_SECRET" });
  }
  if (rateLimitSecretVersionValue && rateLimitSecretVersion === undefined) {
    issues.push({ code: "INVALID", key: "RATE_LIMIT_SECRET_VERSION" });
  }

  if (issues.length) throw new WebConfigError(issues);
  return Object.freeze({
    target,
    ...(access ? { access } : {}),
    ...(ownerEmail && publishableKey && supabaseURL
      ? { auth: Object.freeze({ ownerEmail, publishableKey, url: supabaseURL.replace(/\/$/, "") }) }
      : {}),
    ...(supabaseURL && serviceRoleKey
      ? { supabase: Object.freeze({ serviceRoleKey, url: supabaseURL.replace(/\/$/, "") }) }
      : {}),
    ...(deepseekKey
      ? { deepseek: Object.freeze({ apiKey: deepseekKey, baseURL: "https://api.deepseek.com" as const }) }
      : {}),
    ...(feedbackSecret && webBaseURL
      ? { feedback: Object.freeze({ secret: feedbackSecret, webBaseURL: webBaseURL.replace(/\/$/, "") }) }
      : {}),
    ...(rateLimitSecret && rateLimitSecretVersion !== undefined && supabaseURL && serviceRoleKey
      ? {
          quota: Object.freeze({
            secret: rateLimitSecret,
            secretVersion: rateLimitSecretVersion,
            serviceRoleKey,
            url: supabaseURL.replace(/\/$/, ""),
          }),
        }
      : {}),
  });
}
