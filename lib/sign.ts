import { loadFeedbackConfig } from "./runtime-config.ts";
import { currentRuntimeEnvironment } from "./runtime-env.ts";
import {
  issueFeedbackToken as issueWithSecret,
  type FeedbackTokenInput,
} from "./feedback-token.ts";

export function issueFeedbackToken(input: FeedbackTokenInput): string {
  return issueWithSecret(loadFeedbackConfig(currentRuntimeEnvironment()).secret, input);
}
