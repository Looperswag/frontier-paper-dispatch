import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import RootLayout from "../../app/layout";

describe("public and private route layout boundary", () => {
  test("the root shell renders public content without private data components", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <p>public login-safe content</p>
      </RootLayout>,
    );

    expect(markup).toContain("public login-safe content");
    const source = readFileSync("app/layout.tsx", "utf8");
    expect(source).not.toMatch(/PaperList|ChatPanel|@\/lib\/data/);
  });

  test("authentication pages never block on third-party font hosts", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <p>login</p>
      </RootLayout>,
    );
    const source = readFileSync("app/layout.tsx", "utf8");

    expect(markup).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/i);
    expect(source).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com|https?:\/\//i);
  });

  test("the private shell owns the paper list and chat panel", () => {
    const source = readFileSync("app/(private)/layout.tsx", "utf8");

    expect(source).toMatch(/import ChatPanel from ["']@\/components\/ChatPanel["']/);
    expect(source).toMatch(/import PaperList from ["']@\/components\/PaperList["']/);
    expect(source).toContain('<div className="app">');
    expect(source).toContain("<PaperList />");
    expect(source).toContain('<main className="center">{children}</main>');
    expect(source).toContain("<ChatPanel />");
  });

  test("moves every private page into a URL-transparent route group", () => {
    for (const path of [
      "app/(private)/page.tsx",
      "app/(private)/paper/[id]/page.tsx",
      "app/(private)/search/page.tsx",
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
    for (const path of ["app/page.tsx", "app/paper/[id]/page.tsx", "app/search/page.tsx"]) {
      expect(existsSync(path), path).toBe(false);
    }
  });
});
