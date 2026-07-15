export type ConfigTarget =
  | "all"
  | "dry"
  | "deliver"
  | "ingest"
  | "ingest:send"
  | "push:last"
  | "refine";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  code: "CONFLICT" | "FORBIDDEN_PUBLIC_SECRET" | "INVALID" | "MISSING";
  key: string;
  relatedKey?: string;
}

export class ConfigError extends Error {
  readonly code = "INVALID_RUNTIME_CONFIG";
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const safeIssues = issues.map((issue) => Object.freeze({ ...issue }));
    const summary = safeIssues
      .map((issue) =>
        `${issue.code}:${issue.key}${issue.relatedKey ? `:${issue.relatedKey}` : ""}`,
      )
      .join(", ");
    super(`Runtime configuration is invalid (${summary})`);
    this.name = "ConfigError";
    this.issues = Object.freeze(safeIssues);
  }
}

export interface RootRuntimeConfig {
  readonly deepseek?: Readonly<{ apiKey: string; baseURL: "https://api.deepseek.com" }>;
  readonly deprecations: readonly string[];
  readonly smtp?: Readonly<SMTPConfig>;
  readonly alert?: Readonly<AlertConfig>;
  readonly feedback?: Readonly<{ secret: string; webBaseURL: string }>;
  readonly githubToken?: string;
  readonly openAlexApiKey?: string;
  readonly serverChan?: Readonly<{ sendKey: string }>;
  readonly supabase?: Readonly<{ serviceRoleKey: string; url: string }>;
  readonly target: ConfigTarget;
}

export type DeepSeekConfig = NonNullable<RootRuntimeConfig["deepseek"]>;
export type FeedbackConfig = NonNullable<RootRuntimeConfig["feedback"]>;
export type ServerChanConfig = NonNullable<RootRuntimeConfig["serverChan"]>;
export type SupabaseConfig = NonNullable<RootRuntimeConfig["supabase"]>;

export interface SMTPConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly to: string;
}

export interface AlertConfig {
  readonly webhookURL: string;
  readonly token?: string;
}

const FORBIDDEN_PUBLIC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_DEEPSEEK_API_KEY",
  "NEXT_PUBLIC_FEEDBACK_SECRET",
  "NEXT_PUBLIC_APP_PASSWORD",
  "NEXT_PUBLIC_GITHUB_TOKEN",
  "NEXT_PUBLIC_OPENALEX_API_KEY",
  "NEXT_PUBLIC_SERVERCHAN_SENDKEY",
  "NEXT_PUBLIC_SERVERCHAN_KEY",
  "NEXT_PUBLIC_LLM_API_KEY",
  "NEXT_PUBLIC_SMTP_PASS",
  "NEXT_PUBLIC_EMAIL_TO",
] as const;

const PUBLIC_ENV_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "NUXT_PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
] as const;

function isPublicAlertKey(key: string): boolean {
  return PUBLIC_ENV_PREFIXES.some((prefix) => key.startsWith(`${prefix}ALERT_`));
}

const TARGET_REQUIREMENTS: Record<
  ConfigTarget,
  readonly ("deepseek" | "feedback" | "serverChan" | "supabase")[]
> = {
  all: ["deepseek", "supabase", "serverChan", "feedback"],
  dry: [],
  deliver: ["supabase", "serverChan"],
  ingest: ["deepseek", "supabase", "feedback"],
  "ingest:send": ["deepseek", "supabase", "serverChan", "feedback"],
  "push:last": ["supabase", "serverChan", "feedback"],
  refine: ["deepseek", "supabase"],
};

function valueOf(env: Environment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function obviousPlaceholder(value: string): boolean {
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

function validDeepSeekLegacy(env: Environment): boolean {
  if (valueOf(env, "LLM_PROVIDER")?.toLowerCase() !== "deepseek") return false;
  const rawURL = valueOf(env, "LLM_BASE_URL");
  if (!rawURL) return false;
  try {
    const url = new URL(rawURL);
    return url.protocol === "https:" &&
      (url.hostname === "deepseek.com" || url.hostname.endsWith(".deepseek.com"));
  } catch {
    return false;
  }
}

function resolveAlias(
  env: Environment,
  canonicalKey: string,
  legacyKey: string,
  legacyAllowed: boolean,
  issues: ConfigIssue[],
  deprecations: string[],
): string | undefined {
  const canonical = valueOf(env, canonicalKey);
  const legacy = legacyAllowed ? valueOf(env, legacyKey) : undefined;
  if (canonical && legacy && canonical !== legacy) {
    issues.push({
      code: "CONFLICT",
      key: canonicalKey,
      relatedKey: legacyKey,
    });
    return undefined;
  }
  if (canonical) {
    if (legacy) deprecations.push(`${legacyKey}->${canonicalKey}`);
    return canonical;
  }
  if (legacy) {
    deprecations.push(`${legacyKey}->${canonicalKey}`);
    return legacy;
  }
  return undefined;
}

function isLoopback(hostname: string): boolean {
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
    if (placeholderHostname || obviousPlaceholder(rawURL)) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

function invalidServiceRoleKey(value: string): boolean {
  if (
    value.length < 24 ||
    !validHeaderToken(value) ||
    obviousPlaceholder(value) ||
    /^sb_publishable_/i.test(value)
  ) {
    return true;
  }
  const segments = value.split(".");
  if (segments.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as {
      role?: unknown;
    };
    return typeof payload.role === "string" && payload.role !== "service_role";
  } catch {
    return false;
  }
}

function requireCapability(
  required: ReadonlySet<string>,
  capability: string,
  values: readonly [string, string | undefined][],
  issues: ConfigIssue[],
): void {
  if (!required.has(capability)) return;
  for (const [key, value] of values) {
    if (!value) issues.push({ code: "MISSING", key });
  }
}

export function loadRootConfig(
  target: ConfigTarget,
  env: Environment = process.env,
): RootRuntimeConfig {
  if (!Object.hasOwn(TARGET_REQUIREMENTS, target)) {
    throw new ConfigError([{ code: "INVALID", key: "target" }]);
  }
  const issues: ConfigIssue[] = [];
  const deprecations: string[] = [];

  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (valueOf(env, key)) issues.push({ code: "FORBIDDEN_PUBLIC_SECRET", key });
  }
  for (const key of Object.keys(env)) {
    if (isPublicAlertKey(key) && valueOf(env, key)) {
      issues.push({ code: "FORBIDDEN_PUBLIC_SECRET", key });
    }
  }

  const deepseekKey = resolveAlias(
    env,
    "DEEPSEEK_API_KEY",
    "LLM_API_KEY",
    validDeepSeekLegacy(env),
    issues,
    deprecations,
  );
  const serverChanKey = resolveAlias(
    env,
    "SERVERCHAN_SENDKEY",
    "SERVERCHAN_KEY",
    true,
    issues,
    deprecations,
  );
  const supabaseURL = valueOf(env, "SUPABASE_URL");
  const serviceRoleKey = valueOf(env, "SUPABASE_SERVICE_ROLE_KEY");
  const webBaseURL = valueOf(env, "WEB_BASE_URL");
  const feedbackSecret = valueOf(env, "FEEDBACK_SECRET");
  const githubToken = valueOf(env, "GITHUB_TOKEN");
  const openAlexApiKey = valueOf(env, "OPENALEX_API_KEY");
  const alertWebhookURL = valueOf(env, "ALERT_WEBHOOK_URL");
  const alertWebhookToken = valueOf(env, "ALERT_WEBHOOK_TOKEN");
  const smtpValues = {
    host: valueOf(env, "SMTP_HOST"),
    port: valueOf(env, "SMTP_PORT"),
    secure: valueOf(env, "SMTP_SECURE"),
    user: valueOf(env, "SMTP_USER"),
    pass: valueOf(env, "SMTP_PASS"),
    from: valueOf(env, "EMAIL_FROM"),
    to: valueOf(env, "EMAIL_TO"),
  };
  const smtpConfigured = Object.values(smtpValues).some((value) => value !== undefined);
  if (alertWebhookToken && !alertWebhookURL) issues.push({ code: "MISSING", key: "ALERT_WEBHOOK_URL" });
  if (alertWebhookURL) {
    try {
      const url = new URL(alertWebhookURL);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || alertWebhookURL.length > 2048) {
        issues.push({ code: "INVALID", key: "ALERT_WEBHOOK_URL" });
      }
    } catch {
      issues.push({ code: "INVALID", key: "ALERT_WEBHOOK_URL" });
    }
  }
  if (alertWebhookToken && (!validHeaderToken(alertWebhookToken) || alertWebhookToken.length > 512)) {
    issues.push({ code: "INVALID", key: "ALERT_WEBHOOK_TOKEN" });
  }

  const required = new Set(TARGET_REQUIREMENTS[target]);
  requireCapability(required, "deepseek", [["DEEPSEEK_API_KEY", deepseekKey]], issues);
  requireCapability(
    required,
    "supabase",
    [
      ["SUPABASE_URL", supabaseURL],
      ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
    ],
    issues,
  );
  requireCapability(
    required,
    "serverChan",
    [["SERVERCHAN_SENDKEY", serverChanKey]],
    issues,
  );
  requireCapability(
    required,
    "feedback",
    [
      ["WEB_BASE_URL", webBaseURL],
      ["FEEDBACK_SECRET", feedbackSecret],
    ],
    issues,
  );

  if (
    deepseekKey &&
    (deepseekKey.length < 16 || !validHeaderToken(deepseekKey) || obviousPlaceholder(deepseekKey))
  ) {
    issues.push({ code: "INVALID", key: "DEEPSEEK_API_KEY" });
  }
  if (supabaseURL && !validBaseURL(supabaseURL)) {
    issues.push({ code: "INVALID", key: "SUPABASE_URL" });
  }
  if (serviceRoleKey && invalidServiceRoleKey(serviceRoleKey)) {
    issues.push({ code: "INVALID", key: "SUPABASE_SERVICE_ROLE_KEY" });
  }
  if (supabaseURL && !serviceRoleKey) {
    issues.push({ code: "MISSING", key: "SUPABASE_SERVICE_ROLE_KEY" });
  }
  if (serviceRoleKey && !supabaseURL) issues.push({ code: "MISSING", key: "SUPABASE_URL" });
  if (
    serverChanKey &&
    !/^SCT[A-Za-z0-9_-]{10,}$/.test(serverChanKey) &&
    !/^sctp\d+t[A-Za-z0-9_-]{10,}$/.test(serverChanKey)
  ) {
    issues.push({ code: "INVALID", key: "SERVERCHAN_SENDKEY" });
  }
  if (
    githubToken &&
    (githubToken.length < 20 || !validHeaderToken(githubToken) || obviousPlaceholder(githubToken))
  ) {
    issues.push({ code: "INVALID", key: "GITHUB_TOKEN" });
  }
  if (
    openAlexApiKey &&
    (openAlexApiKey.length < 8 ||
      openAlexApiKey.length > 512 ||
      !validHeaderToken(openAlexApiKey) ||
      obviousPlaceholder(openAlexApiKey))
  ) {
    issues.push({ code: "INVALID", key: "OPENALEX_API_KEY" });
  }

  if (webBaseURL && !feedbackSecret) issues.push({ code: "MISSING", key: "FEEDBACK_SECRET" });
  if (feedbackSecret && !webBaseURL) issues.push({ code: "MISSING", key: "WEB_BASE_URL" });
  if (webBaseURL && !validBaseURL(webBaseURL)) {
    issues.push({ code: "INVALID", key: "WEB_BASE_URL" });
  }
  if (
    feedbackSecret &&
    (Buffer.byteLength(feedbackSecret, "utf8") < 32 ||
      hasControlCharacter(feedbackSecret) ||
      obviousPlaceholder(feedbackSecret))
  ) {
    issues.push({ code: "INVALID", key: "FEEDBACK_SECRET" });
  }

  if (smtpConfigured) {
    for (const [key, value] of Object.entries(smtpValues)) {
      if (!value) issues.push({ code: "MISSING", key: key === "from" || key === "to" ? `EMAIL_${key.toUpperCase()}` : `SMTP_${key.toUpperCase()}` });
    }
    const port = Number(smtpValues.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      issues.push({ code: "INVALID", key: "SMTP_PORT" });
    }
    if (smtpValues.secure !== "true" && smtpValues.secure !== "false") {
      issues.push({ code: "INVALID", key: "SMTP_SECURE" });
    }
    for (const [key, value] of Object.entries(smtpValues)) {
      if (value && hasControlCharacter(value)) {
        issues.push({ code: "INVALID", key: key === "from" || key === "to" ? `EMAIL_${key.toUpperCase()}` : `SMTP_${key.toUpperCase()}` });
      }
    }
    if (smtpValues.host && !/^[A-Za-z0-9.-]+$/.test(smtpValues.host)) {
      issues.push({ code: "INVALID", key: "SMTP_HOST" });
    }
    for (const key of ["from", "to"] as const) {
      const value = smtpValues[key];
      if (value && (!value.includes("@") || value.length > 320)) {
        issues.push({ code: "INVALID", key: key === "from" ? "EMAIL_FROM" : "EMAIL_TO" });
      }
    }
  }

  if (issues.length) throw new ConfigError(issues);

  const config: RootRuntimeConfig = {
    target,
    deprecations: Object.freeze([...deprecations]),
    ...(deepseekKey
      ? { deepseek: Object.freeze({ apiKey: deepseekKey, baseURL: "https://api.deepseek.com" as const }) }
      : {}),
    ...(supabaseURL && serviceRoleKey
      ? { supabase: Object.freeze({ serviceRoleKey, url: supabaseURL.replace(/\/$/, "") }) }
      : {}),
    ...(serverChanKey ? { serverChan: Object.freeze({ sendKey: serverChanKey }) } : {}),
    ...(webBaseURL && feedbackSecret
      ? { feedback: Object.freeze({ secret: feedbackSecret, webBaseURL: webBaseURL.replace(/\/$/, "") }) }
      : {}),
    ...(smtpConfigured
      ? {
          smtp: Object.freeze({
            host: smtpValues.host as string,
            port: Number(smtpValues.port),
            secure: smtpValues.secure === "true",
            user: smtpValues.user as string,
            pass: smtpValues.pass as string,
            from: smtpValues.from as string,
            to: smtpValues.to as string,
          }),
        }
      : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(openAlexApiKey ? { openAlexApiKey } : {}),
    ...(alertWebhookURL
      ? { alert: Object.freeze({ webhookURL: alertWebhookURL, ...(alertWebhookToken ? { token: alertWebhookToken } : {}) }) }
      : {}),
  };
  return Object.freeze(config);
}

export function loadDeepSeekConfig(env: Environment = process.env): DeepSeekConfig {
  const config = loadRootConfig("dry", env);
  if (!config.deepseek) throw new ConfigError([{ code: "MISSING", key: "DEEPSEEK_API_KEY" }]);
  return config.deepseek;
}

export function loadSupabaseConfig(env: Environment = process.env): SupabaseConfig {
  const config = loadRootConfig("dry", env);
  if (!config.supabase) {
    throw new ConfigError([
      { code: "MISSING", key: "SUPABASE_URL" },
      { code: "MISSING", key: "SUPABASE_SERVICE_ROLE_KEY" },
    ]);
  }
  return config.supabase;
}

export function loadServerChanConfig(env: Environment = process.env): ServerChanConfig {
  const config = loadRootConfig("dry", env);
  if (!config.serverChan) {
    throw new ConfigError([{ code: "MISSING", key: "SERVERCHAN_SENDKEY" }]);
  }
  return config.serverChan;
}

export function loadFeedbackConfig(env: Environment = process.env): FeedbackConfig {
  const config = loadRootConfig("dry", env);
  if (!config.feedback) {
    throw new ConfigError([
      { code: "MISSING", key: "WEB_BASE_URL" },
      { code: "MISSING", key: "FEEDBACK_SECRET" },
    ]);
  }
  return config.feedback;
}

export function loadOptionalFeedbackConfig(
  env: Environment = process.env,
): FeedbackConfig | undefined {
  return loadRootConfig("dry", env).feedback;
}

export function loadOptionalSMTPConfig(env: Environment = process.env): SMTPConfig | undefined {
  return loadRootConfig("dry", env).smtp;
}

export function loadOptionalAlertConfig(env: Environment = process.env): AlertConfig | undefined {
  return loadRootConfig("dry", env).alert;
}
