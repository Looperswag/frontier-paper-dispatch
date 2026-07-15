import { beforeEach, describe, expect, test, vi } from "vitest";
import { withRuntimeEnvironment } from "./runtime-env.ts";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

import { classifyEmailFailure, emailTransportOptions, sendEmail } from "./email.ts";

const environment = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "mailer@example.com",
  SMTP_PASS: "super-secret",
  EMAIL_FROM: "mailer@example.com",
  EMAIL_TO: "hgjly1206@163.com",
};

beforeEach(() => {
  mocks.sendMail.mockReset().mockResolvedValue({});
  mocks.close.mockReset();
  mocks.createTransport.mockReset().mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
});

describe("SMTP email delivery", () => {
  test("uses TLS/timeouts, multipart content, and a stable idempotent Message-ID", async () => {
    const message = { subject: "Digest", text: "<script>alert(1)</script>\n正文", idempotencyKey: "digest:2026-07-14:email" };
    const first = await withRuntimeEnvironment(environment, () => sendEmail(message));
    const second = await withRuntimeEnvironment(environment, () => sendEmail(message));

    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.com",
      secure: true,
      connectionTimeout: 30_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    }));
    expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({
      from: "mailer@example.com",
      to: "hgjly1206@163.com",
      headers: { "X-Frontier-Idempotency-Key": message.idempotencyKey },
    });
    expect(mocks.sendMail.mock.calls[0][0].html).toContain("&lt;script&gt;");
    expect(first).toEqual(second);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  test("fails closed when a claimed email no longer has SMTP configuration", async () => {
    await expect(withRuntimeEnvironment(
      {},
      () => sendEmail({ subject: "x", text: "x", idempotencyKey: "x" }),
    )).rejects.toThrow("SMTP delivery is not configured");
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  test("classifies temporary SMTP failures for outbox retry", () => {
    expect(classifyEmailFailure({ code: "ETIMEDOUT" })).toBe("retryable");
    expect(classifyEmailFailure({ responseCode: 451 })).toBe("retryable");
    expect(classifyEmailFailure({ responseCode: 550 })).toBe("permanent");
    expect(emailTransportOptions({
      host: environment.SMTP_HOST,
      port: 465,
      secure: true,
      user: environment.SMTP_USER,
      pass: environment.SMTP_PASS,
      from: environment.EMAIL_FROM,
      to: environment.EMAIL_TO,
    }).tls).toEqual({
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
  });
});
