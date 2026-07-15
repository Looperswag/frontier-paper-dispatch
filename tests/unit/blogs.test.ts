import { expect, test, vi } from "vitest";
import {
  BLOG_FEED_REQUEST_BOUNDS,
  combineBlogSourceResults,
  extractPageContent,
  isAllowedBlogPageURL,
  isTrustedBlogPageURL,
  mapSitemapItems,
  parseBlogSourceDocument,
  stripHtml,
} from "../../scripts/fetchers/blogs.ts";
import type { BlogSource } from "../../config/sources.ts";

const source = (publisher: string): BlogSource => ({
  publisher,
  url: `https://${publisher.toLowerCase()}.example/feed.xml`,
  kind: "feed",
  pageHosts: [`${publisher.toLowerCase()}.example`],
});

test("blog HTML extraction removes executable markup and bounds article content", () => {
  expect(stripHtml("<script>alert(1)</script><p>Hello&nbsp;&amp; world</p>")).toBe("Hello & world");
  expect(extractPageContent("<html><head><title>Paper</title><meta name=\"description\" content=\"Short\"></head><body><article><p>Body</p></article></body></html>")).toEqual({
    title: "Paper",
    description: "Short",
    body: "Body",
  });
});

test("blog page enrichment rejects non-HTTPS, private, and lookalike hosts", () => {
  expect(isTrustedBlogPageURL("https://www.anthropic.com/news/model", ["anthropic.com"])).toBe(true);
  expect(isTrustedBlogPageURL("http://anthropic.com/news/model", ["anthropic.com"])).toBe(false);
  expect(isTrustedBlogPageURL("https://anthropic.com.evil.test/news/model", ["anthropic.com"])).toBe(false);
  expect(isTrustedBlogPageURL("https://127.0.0.1/internal", ["anthropic.com"])).toBe(false);
});

test("blog sources can constrain feed entries to an official path", () => {
  const microsoft = {
    publisher: "Microsoft Research",
    url: "https://www.microsoft.com/en-us/research/blog/feed/",
    kind: "feed" as const,
    pageHosts: ["microsoft.com"],
    allowedPathPrefixes: ["/en-us/research/blog/"],
  };
  expect(isAllowedBlogPageURL("https://www.microsoft.com/en-us/research/blog/agents/", microsoft)).toBe(true);
  expect(isAllowedBlogPageURL("https://www.microsoft.com/en-us/security/blog/post/", microsoft)).toBe(false);
  expect(() => parseBlogSourceDocument("<html><body>challenge</body></html>", microsoft)).toThrow(/schema/i);
});

test("sitemap adapter keeps recent publisher pages in deterministic order", () => {
  const items = mapSitemapItems({ urlset: { url: [
    { loc: "https://www.anthropic.com/news/older", lastmod: "2026-07-14T10:00:00Z" },
    { loc: "https://www.anthropic.com/about", lastmod: "2026-07-15T11:00:00Z" },
    { loc: "https://www.anthropic.com/news/newer", lastmod: "2026-07-15T10:00:00Z" },
  ] } }, {
    allowedPathPrefixes: ["/news/"],
    pageHosts: ["anthropic.com"],
    publisher: "Anthropic",
  });
  expect(items.map((item) => item.url)).toEqual([
    "https://www.anthropic.com/news/newer",
    "https://www.anthropic.com/news/older",
  ]);
});

test("blog aggregation reports partial failures and fails when every publisher is unavailable", () => {
  const warn = { warn: vi.fn() };
  const item = mapSitemapItems({ urlset: { url: [
    { loc: "https://www.anthropic.com/news/model", lastmod: "2026-07-15T10:00:00Z" },
  ] } }, {
    allowedPathPrefixes: ["/news/"],
    pageHosts: ["anthropic.com"],
    publisher: "Anthropic",
  })[0];
  expect(combineBlogSourceResults(
    [source("One"), source("Two")],
    [{ status: "fulfilled", value: [item] }, { status: "rejected", reason: new Error("offline") }],
    warn,
  )).toEqual([item]);
  expect(warn.warn).toHaveBeenCalledWith(expect.stringMatching(/Two.*失败.*offline/));
  expect(() => combineBlogSourceResults(
    [source("One")],
    [{ status: "rejected", reason: new Error("offline") }],
    warn,
  )).toThrow(/all configured blog sources failed/i);
});

test("blog feeds retain a bounded two-attempt budget for slow official RSS responses", () => {
  expect(BLOG_FEED_REQUEST_BOUNDS).toMatchObject({
    deadlineMs: 35_000,
    maxAttempts: 2,
    maxResponseBytes: 1024 * 1024,
    timeoutMs: 15_000,
  });
});
