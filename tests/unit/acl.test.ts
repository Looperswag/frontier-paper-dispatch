import { expect, test } from "vitest";
import {
  ACL_ANTHOLOGY_FEED_URL,
  mapAclAnthologyFeed,
  parseAclAnthologyFeed,
} from "../../scripts/fetchers/acl.ts";

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>ACL Anthology</title>
  <item><title>ACL agents</title><link>https://aclanthology.org/2026.acl-long.1/</link><guid>2026.acl-long.1</guid><pubDate>Tue, 14 Jul 2026 00:00:00 +0000</pubDate><description>Alice A. and Bob B. in Proceedings of ACL</description></item>
  <item><title>EMNLP retrieval</title><link>https://aclanthology.org/2026.emnlp-main.2/</link><guid>2026.emnlp-main.2</guid><pubDate>Mon, 13 Jul 2026 00:00:00 +0000</pubDate><description>Carol C. in Proceedings of EMNLP</description></item>
  <item><title>Workshop paper</title><link>https://aclanthology.org/2026.nlpcss-1.3/</link><guid>2026.nlpcss-1.3</guid><pubDate>Tue, 14 Jul 2026 00:00:00 +0000</pubDate><description>Dan D. in Proceedings of NLP CSS</description></item>
  <item><title>Lookalike</title><link>https://aclanthology.org.evil.test/2026.acl-long.4/</link><guid>2026.acl-long.4</guid><pubDate>Tue, 14 Jul 2026 00:00:00 +0000</pubDate><description>Eve in Proceedings of ACL</description></item>
</channel></rss>`;

test("ACL Anthology uses the official bounded papers feed", () => {
  expect(ACL_ANTHOLOGY_FEED_URL).toBe("https://aclanthology.org/papers/index.xml");
});

test("ACL feed keeps selected venues and rejects workshop and lookalike links", () => {
  const items = mapAclAnthologyFeed(parseAclAnthologyFeed(feed));

  expect(items).toEqual([
    expect.objectContaining({
      source: "acl",
      externalId: "2026.acl-long.1",
      url: "https://aclanthology.org/2026.acl-long.1/",
      authors: ["Alice A.", "Bob B."],
      publishedAt: "2026-07-14T00:00:00.000Z",
      signals: expect.objectContaining({ venue: "acl" }),
    }),
    expect.objectContaining({
      source: "acl",
      externalId: "2026.emnlp-main.2",
      signals: expect.objectContaining({ venue: "emnlp" }),
    }),
  ]);
});

test("ACL feed rejects malformed XML and an unexpected schema", () => {
  expect(() => parseAclAnthologyFeed("<rss><channel>")).toThrow(/invalid XML/i);
  expect(() => parseAclAnthologyFeed("<html><body>challenge</body></html>")).toThrow(/RSS schema/i);
  expect(() => parseAclAnthologyFeed(
    "<rss><channel><item>challenge</item></channel></rss>",
  )).toThrow(/paper schema/i);
});
