import { expect, test, vi } from "vitest";
import { alertRequest, sendFailureAlert } from "./alert.ts";
import { withRuntimeEnvironment } from "./runtime-env.ts";

const config = { webhookURL: "https://alerts.example.test/hook", token: "secret" } as const;

test("alert request is bounded JSON with optional bearer token", () => {
  const request = alertRequest({ event: "delivery_failed", severity: "critical", detail: "smtp" }, config);
  expect(request.url).toBe(config.webhookURL);
  expect(request.method).toBe("POST");
  expect(request.headers).toMatchObject({ Authorization: "Bearer secret" });
  expect(JSON.parse(String(request.body))).toMatchObject({ source: "frontier-paper-dispatch", event: "delivery_failed" });
});

test("alert transport is independent and failure-safe", async () => {
  const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
  await expect(sendFailureAlert(
    { event: "pipeline_failed", severity: "critical", detail: "provider" },
    { ALERT_WEBHOOK_URL: config.webhookURL, ALERT_WEBHOOK_TOKEN: config.token },
    fetchImpl,
  )).resolves.toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(sendFailureAlert(
    { event: "pipeline_failed", severity: "critical", detail: "provider" },
    {},
    fetchImpl,
  )).resolves.toBe(false);
});

test("successful alert delivery never consumes an untrusted response body", async () => {
  const cancel = vi.fn(async () => undefined);
  const text = vi.fn(async () => {
    throw new Error("response body must not be read");
  });
  const fetchImpl = vi.fn(async () => ({
    body: { cancel },
    ok: true,
    status: 204,
    text,
  })) as unknown as typeof fetch;

  await expect(sendFailureAlert(
    { event: "pipeline_failed", severity: "critical", detail: "provider" },
    { ALERT_WEBHOOK_URL: config.webhookURL },
    fetchImpl,
  )).resolves.toBe(true);
  expect(text).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

test("failed alert delivery discards rather than buffers an untrusted response body", async () => {
  const cancel = vi.fn(async () => undefined);
  const text = vi.fn(async () => "x".repeat(128 * 1024));
  const fetchImpl = vi.fn(async () => ({
    body: { cancel },
    ok: false,
    status: 503,
    text,
  })) as unknown as typeof fetch;

  await expect(sendFailureAlert(
    { event: "pipeline_failed", severity: "critical", detail: "provider" },
    { ALERT_WEBHOOK_URL: config.webhookURL },
    fetchImpl,
  )).resolves.toBe(false);
  expect(text).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

test("unrelated invalid application configuration cannot make alerting throw", async () => {
  await expect(sendFailureAlert(
    { event: "pipeline_failed", severity: "critical", detail: "provider" },
    { SMTP_HOST: "smtp.example.com" },
    vi.fn(),
  )).resolves.toBe(false);
});

test("alert transport reads the scoped runtime environment used by ingest", async () => {
  const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
  await expect(withRuntimeEnvironment(
    { ALERT_WEBHOOK_URL: config.webhookURL, ALERT_WEBHOOK_TOKEN: config.token },
    () => sendFailureAlert(
      { event: "pipeline_failed", severity: "critical", detail: "provider" },
      undefined,
      fetchImpl,
    ),
  )).resolves.toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});
