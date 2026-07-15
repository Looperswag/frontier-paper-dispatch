import { defineConfig, devices } from "@playwright/test";
import {
  OWNER_EMAIL,
  REAL_IDOR_BASE_URL,
  REAL_IDOR_FEEDBACK_SECRET,
  REAL_IDOR_RATE_LIMIT_SECRET,
  TRUSTED_TEST_IP,
} from "./test/real-idor-fixtures";

const port = new URL(REAL_IDOR_BASE_URL).port;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing real IDOR test environment: ${name}`);
  return value;
}

const supabaseURL = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");

export default defineConfig({
  testDir: "./e2e-real",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: REAL_IDOR_BASE_URL,
    extraHTTPHeaders: { "x-vercel-forwarded-for": TRUSTED_TEST_IP },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "real-local-supabase-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      ...process.env,
      AUTH_OWNER_EMAIL: OWNER_EMAIL,
      DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
      FEEDBACK_SECRET: REAL_IDOR_FEEDBACK_SECRET,
      IDOR_JWT_SECRET: "",
      RATE_LIMIT_SECRET: REAL_IDOR_RATE_LIMIT_SECRET,
      RATE_LIMIT_SECRET_VERSION: "1",
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_URL: supabaseURL,
      VERCEL: "1",
      WEB_BASE_URL: REAL_IDOR_BASE_URL,
    },
    reuseExistingServer: false,
    timeout: 180_000,
    url: REAL_IDOR_BASE_URL,
  },
});
