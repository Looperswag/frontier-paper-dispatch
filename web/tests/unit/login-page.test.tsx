import { isValidElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";

import LoginPage, { metadata } from "../../app/login/page";
import LoginForm from "../../components/LoginForm";

async function pageReturnTo(
  returnTo?: string | string[],
  extra: Record<string, string | string[] | undefined> = {},
): Promise<string | undefined> {
  const page = await LoginPage({
    searchParams: Promise.resolve({
      ...extra,
      ...(returnTo === undefined ? {} : { returnTo }),
    }),
  });

  function findLoginForm(node: ReactNode): string | undefined {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findLoginForm(child);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isValidElement<{ children?: ReactNode; returnTo?: string }>(node)) return undefined;
    if (node.type === LoginForm) return node.props.returnTo;
    return findLoginForm(node.props.children);
  }

  return findLoginForm(page);
}

describe("owner login page return target", () => {
  test("server-normalizes and passes a validated internal page and query to the form", async () => {
    await expect(pageReturnTo("/feedback?token=v1_example-token")).resolves.toBe(
      "/feedback?token=v1_example-token",
    );
  });

  test.each([
    ["an external URL", "https://attacker.example/steal"],
    ["a duplicate parameter", ["/paper/one", "/paper/two"]],
    ["an encoded protected route", "/%61pi/feedback"],
  ])("passes home for %s", async (_name, returnTo) => {
    await expect(pageReturnTo(returnTo)).resolves.toBe("/");
  });

  test("reads only the exact returnTo key and ignores redirect aliases", async () => {
    await expect(
      pageReturnTo("/paper/one?from=digest", {
        next: "https://attacker.example/steal",
        redirect: "//attacker.example/steal",
        return_to: "/api/private",
      }),
    ).resolves.toBe("/paper/one?from=digest");
  });

  test("forbids referrers and indexing on the token-bearing login page", () => {
    expect(metadata).toMatchObject({
      referrer: "no-referrer",
      robots: "noindex, nofollow, noarchive",
    });
  });
});
