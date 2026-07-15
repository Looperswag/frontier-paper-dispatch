import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const fakeSupabasePort = 54329;
const fakeSupabaseURL = `http://127.0.0.1:${fakeSupabasePort}`;

export default defineConfig({
  testDir: "./e2e",
  // The fake Supabase service is intentionally a single deterministic process;
  // parallel browser workers make login/logout state races look like outages.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    extraHTTPHeaders: { "x-vercel-forwarded-for": "127.0.0.1" },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `node test/fake-supabase.mjs ${fakeSupabasePort}`,
      reuseExistingServer: false,
      timeout: 10_000,
      url: `${fakeSupabaseURL}/health`,
    },
    {
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
      env: {
        ...process.env,
        AUTH_OWNER_EMAIL: "owner@example.com",
        DEEPSEEK_API_KEY: `sk-${"d".repeat(40)}`,
        FEEDBACK_SECRET: "f".repeat(40),
        RATE_LIMIT_SECRET: "r".repeat(40),
        RATE_LIMIT_SECRET_VERSION: "1",
        VERCEL: "1",
        SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"p".repeat(40)}`,
        SUPABASE_URL: fakeSupabaseURL,
        SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"e".repeat(40)}`,
        WEB_BASE_URL: baseURL,
      },
      reuseExistingServer: false,
      timeout: 180_000,
      url: baseURL,
    },
  ],
});
