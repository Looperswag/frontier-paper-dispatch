import { currentRuntimeEnvironment } from "./runtime-env.ts";

const MAX_ERROR_LENGTH = 1_024;
const SENSITIVE_NAME =
  /(?:api.?key|auth|cookie|credential|password|secret|sendkey|token|(?:^|_)key$)/i;

type Environment = Readonly<Record<string, string | undefined>>;

function stripURLDetails(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[REDACTED_URL]";
    }
  });
}

function configuredSecrets(env: Environment): string[] {
  const secrets = Object.entries(env)
    .filter(([key, value]) => SENSITIVE_NAME.test(key) && Boolean(value && value.length >= 4))
    .flatMap(([, value]) => {
      const secret = value as string;
      const encoded = encodeURIComponent(secret);
      return encoded === secret ? [secret] : [secret, encoded];
    });
  return [...new Set(secrets)].sort((left, right) => right.length - left.length);
}

export function safeErrorMessage(
  error: unknown,
  env: Environment = currentRuntimeEnvironment(),
): string {
  if (!(error instanceof Error)) return "Operation failed with a non-Error rejection";
  let message = error.message || "Operation failed";
  for (const secret of configuredSecrets(env)) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-|sb_secret_|sb_publishable_|SCT|sctp\d+t)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    );
  message = stripURLDetails(message);
  return message.slice(0, MAX_ERROR_LENGTH);
}
