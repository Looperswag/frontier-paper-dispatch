import { describe, expect, test } from "vitest";
import { renderMarkdown } from "@/lib/md";

describe("renderMarkdown", () => {
  test("keeps useful Markdown and hardens the same external link", () => {
    const html = renderMarkdown("## Result\n\n[paper](https://example.com)");
    const document = new DOMParser().parseFromString(html, "text/html");
    const link = document.querySelector("a");

    expect(html).toContain("<h2>Result</h2>");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test.each([
    '[bad](JaVaScRiPt:alert(1))',
    '<a href="java&#x73;cript:alert(1)">bad</a>',
    '<a href="java\nscript:alert(1)">bad</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">bad</a>',
  ])("removes dangerous URL variants: %s", (markdown) => {
    const document = new DOMParser().parseFromString(renderMarkdown(markdown), "text/html");

    for (const link of document.querySelectorAll("a")) {
      expect(link.hasAttribute("href")).toBe(false);
    }
  });

  test("removes executable markup and overrides attacker-controlled link attributes", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><a href="https://example.com" onclick="alert(2)" target="evil" rel="opener">safe</a>',
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const link = document.querySelector("a");

    expect(html).not.toContain("<script");
    expect(link?.hasAttribute("onclick")).toBe(false);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
