import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function filesBelow(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? filesBelow(child) : [child];
  });
}

async function signInOwner(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("访问口令").fill("e2e-private-password-with-entropy");
  const loginResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/login"),
  );
  await page.getByRole("button", { name: "进入情报台" }).click();
  expect((await loginResponsePromise).status()).toBe(204);
  await expect(page).toHaveURL("/");
}

test("anonymous and legacy Basic requests cannot reach private pages or APIs", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL("/login?returnTo=%2F");

  const anonymousAPI = await page.request.post("/api/chat", {
    data: { itemId: "00000000-0000-4000-8000-000000000001", message: "hello" },
  });
  expect(anonymousAPI.status()).toBe(401);
  expect(await anonymousAPI.text()).toBe("Authentication required");

  const legacyBasic = `Basic ${Buffer.from(
    "owner:e2e-private-password-with-entropy",
  ).toString("base64")}`;
  const basicPage = await page.request.get("/", {
    headers: { Authorization: legacyBasic },
    maxRedirects: 0,
  });
  const basicAPI = await page.request.post("/api/chat", {
    data: { itemId: "00000000-0000-4000-8000-000000000001", message: "hello" },
    headers: { Authorization: legacyBasic },
  });
  expect(basicPage.status()).toBe(307);
  expect(basicPage.headers().location).toBe("/login?returnTo=%2F");
  expect(basicAPI.status()).toBe(401);
});

test("renders a deterministic digest returned by the test Supabase service", async ({ page }) => {
  await signInOwner(page);
  const response = await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "今日前沿 · Top 1" })).toBeVisible();
  await expect(page.getByText("每日电讯 · 2026-07-10")).toBeVisible();
  await expect(page.getByRole("link", { name: "Deterministic Test Paper" }).first()).toBeVisible();
  await expect(page.getByText("A deterministic one-line summary.").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "跨库检索" })).toBeVisible();

  const privateSentinels = [
    `sb_secret_${"e".repeat(40)}`,
    "r".repeat(40),
  ];
  const responseText = await response?.text();
  const pageHTML = await page.content();
  for (const sentinel of privateSentinels) {
    expect(responseText).not.toContain(sentinel);
    expect(pageHTML).not.toContain(sentinel);
  }
  const scriptSources = await page.locator("script[src]").evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).src),
  );
  for (const source of scriptSources) {
    const script = await page.request.get(source);
    const sourceText = await script.text();
    for (const sentinel of privateSentinels) expect(sourceText).not.toContain(sentinel);
  }
  for (const asset of filesBelow(join(process.cwd(), ".next/static"))) {
    const bytes = readFileSync(asset);
    for (const sentinel of privateSentinels) {
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
    }
  }
});

test("the configured owner can create a secure session from the public login page", async ({
  context,
  page,
}) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "身份验证" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /email|邮箱/i })).toHaveCount(0);
  await signInOwner(page);
  await expect(page.getByRole("heading", { name: "今日前沿 · Top 1" })).toBeVisible();
  const authCookie = (await context.cookies()).find((cookie) =>
    cookie.name.endsWith("-auth-token"),
  );
  expect(authCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
});

test("login returns the owner to the exact protected page and query", async ({ page }) => {
  await page.goto("/search?q=agent-systems&from=digest", {
    waitUntil: "domcontentloaded",
  });
  const loginURL = new URL(page.url());
  expect(loginURL.pathname).toBe("/login");
  expect(loginURL.searchParams.get("returnTo")).toBe(
    "/search?q=agent-systems&from=digest",
  );

  await page.getByLabel("访问口令").fill("e2e-private-password-with-entropy");
  const loginResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/login"),
  );
  await page.getByRole("button", { name: "进入情报台" }).click();

  expect((await loginResponsePromise).status()).toBe(204);
  await expect(page).toHaveURL("/search?q=agent-systems&from=digest");
});

test("a rejected password stays on the login page with a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("访问口令").fill("wrong password");
  const loginResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/login"),
  );
  await page.getByRole("button", { name: "进入情报台" }).click();
  const loginResponse = await loginResponsePromise;

  expect(loginResponse.status()).toBe(401);
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("status")).toHaveText("登录失败，请检查口令后重试");
  await expect(page.getByText(/owner@example\.com|invalid_credentials/i)).toHaveCount(0);
});

test("logout clears the local session and immediately restores denial", async ({
  context,
  page,
}) => {
  await signInOwner(page);
  await page.getByRole("button", { name: "退出当前会话" }).click();

  await expect(page).toHaveURL("/login");
  expect((await context.cookies()).some((cookie) => cookie.name.endsWith("-auth-token"))).toBe(
    false,
  );
  const response = await page.request.get("/api/feedback");
  expect(response.status()).toBe(401);
});

test("the fake Auth verifier rejects a missing or invalid bearer token", async ({ request }) => {
  for (const headers of [undefined, { Authorization: "Bearer invalid-token" }]) {
    const response = await request.get("http://127.0.0.1:54329/auth/v1/user", { headers });
    expect(response.status()).toBe(401);
  }
});

test("parallel fake Auth sessions have unique tokens and logout isolation", async ({ request }) => {
  const signIn = async () => {
    const response = await request.post(
      "http://127.0.0.1:54329/auth/v1/token?grant_type=password",
      { data: { email: "owner@example.com", password: "e2e-private-password-with-entropy" } },
    );
    expect(response.status()).toBe(200);
    return (await response.json()) as { access_token: string; refresh_token: string };
  };
  const [first, second] = await Promise.all([signIn(), signIn()]);
  expect(first.access_token).not.toBe(second.access_token);
  expect(first.refresh_token).not.toBe(second.refresh_token);

  const authHeaders = (accessToken: string) => ({
    Authorization: `Bearer ${accessToken}`,
  });
  expect(
    (await request.get("http://127.0.0.1:54329/auth/v1/user", { headers: authHeaders(first.access_token) })).status(),
  ).toBe(200);
  expect(
    (await request.get("http://127.0.0.1:54329/auth/v1/user", { headers: authHeaders(second.access_token) })).status(),
  ).toBe(200);

  expect(
    (
      await request.post("http://127.0.0.1:54329/auth/v1/logout", {
        headers: authHeaders(first.access_token),
      })
    ).status(),
  ).toBe(204);
  expect(
    (await request.get("http://127.0.0.1:54329/auth/v1/user", { headers: authHeaders(first.access_token) })).status(),
  ).toBe(401);
  expect(
    (await request.get("http://127.0.0.1:54329/auth/v1/user", { headers: authHeaders(second.access_token) })).status(),
  ).toBe(200);
});

test("the fake REST API accepts only the configured service role", async ({ request }) => {
  const endpoint = "http://127.0.0.1:54329/rest/v1/digests";
  const publishable = `sb_publishable_${"p".repeat(40)}`;
  const serviceRole = `sb_secret_${"e".repeat(40)}`;
  for (const headers of [
    undefined,
    { apikey: publishable, Authorization: `Bearer ${publishable}` },
    { apikey: serviceRole, Authorization: "Bearer wrong-service-role" },
  ]) {
    expect((await request.get(endpoint, { headers })).status()).toBe(401);
  }
  expect(
    (
      await request.get(endpoint, {
        headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
      })
    ).status(),
  ).toBe(200);
});

test("the fake latest-bundle RPC rejects missing or invalid service credentials", async ({
  request,
}) => {
  const endpoint = "http://127.0.0.1:54329/rest/v1/rpc/get_latest_digest_bundle";
  const publishable = `sb_publishable_${"p".repeat(40)}`;
  const serviceRole = `sb_secret_${"e".repeat(40)}`;
  for (const headers of [
    undefined,
    { apikey: publishable, Authorization: `Bearer ${publishable}` },
    { apikey: serviceRole, Authorization: "Bearer wrong-service-role" },
    { apikey: "wrong-service-role", Authorization: `Bearer ${serviceRole}` },
  ]) {
    expect((await request.post(endpoint, { data: {}, headers })).status()).toBe(401);
  }
  expect(
    (
      await request.post(endpoint, {
        data: {},
        headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
      })
    ).status(),
  ).toBe(200);
});
