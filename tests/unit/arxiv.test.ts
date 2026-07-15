import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ARXIV_CATEGORIES, PER_SOURCE_LIMIT } from "../../config/sources.ts";

const { httpTextMock } = vi.hoisted(() => ({
  httpTextMock: vi.fn(),
}));

vi.mock("../../lib/http.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/http.ts")>();
  return { ...original, httpText: httpTextMock };
});

import { fetchArxiv } from "../../scripts/fetchers/arxiv.ts";

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/arxiv/${name}`, import.meta.url), "utf8");

function rssItem(id: string, category: string | string[], index: number): string {
  const listedCategories = Array.isArray(category) ? category : [category];
  return `
    <item>
      <title>${listedCategories.join("+")} paper ${index}</title>
      <link>https://arxiv.org/abs/${id}v1</link>
      <description>arXiv:${id}v1 Announce Type: new Abstract: ${listedCategories.join("+")} abstract ${index}.</description>
      <guid isPermaLink="false">oai:arXiv.org:${id}v1</guid>
      ${listedCategories.map((listed) => `<category>${listed}</category>`).join("")}
      <pubDate>Mon, 13 Jul 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>new</arxiv:announce_type>
      <dc:creator>Test Author</dc:creator>
    </item>`;
}

function crossListedFairnessFeed(): string {
  let sequence = 100;
  const items = ARXIV_CATEGORIES.flatMap((category) =>
    Array.from({ length: 6 }, () => {
      const id = `2607.${String(sequence).padStart(5, "0")}`;
      const listed = category === "cs.IR" ? ["cs.AI", "cs.IR"] : [category];
      const item = rssItem(id, listed, sequence);
      sequence += 1;
      return item;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
      <channel>${items.join("")}</channel>
    </rss>`;
}

function fairnessFeed(): string {
  let sequence = 1;
  const items = ARXIV_CATEGORIES.flatMap((category) =>
    Array.from({ length: 6 }, () => {
      const id = `2607.${String(sequence).padStart(5, "0")}`;
      const item = rssItem(id, category, sequence);
      sequence += 1;
      return item;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
      <channel>${items.join("")}</channel>
    </rss>`;
}

describe("fetchArxiv", () => {
  beforeEach(() => {
    httpTextMock.mockReset();
  });

  test("uses one combined RSS request and fairly fills the deterministic global cap", async () => {
    httpTextMock.mockResolvedValue(fairnessFeed());

    const first = await fetchArxiv();
    expect(httpTextMock).toHaveBeenCalledTimes(1);
    const second = await fetchArxiv();

    expect(httpTextMock).toHaveBeenCalledTimes(2);
    expect(httpTextMock).toHaveBeenNthCalledWith(
      1,
      `https://rss.arxiv.org/rss/${ARXIV_CATEGORIES.join("+")}`,
      { timeoutMs: 25_000 },
    );
    expect(httpTextMock).toHaveBeenNthCalledWith(
      2,
      `https://rss.arxiv.org/rss/${ARXIV_CATEGORIES.join("+")}`,
      { timeoutMs: 25_000 },
    );
    expect(first).toHaveLength(PER_SOURCE_LIMIT.arxiv);
    expect(first.map(({ externalId }) => externalId)).toEqual(
      second.map(({ externalId }) => externalId),
    );

    const categoryCounts = first.reduce<Record<string, number>>((counts, item) => {
      const category = String(item.signals.category);
      counts[category] = (counts[category] ?? 0) + 1;
      return counts;
    }, {});
    expect(Object.keys(categoryCounts).sort()).toEqual([...ARXIV_CATEGORIES].sort());
    expect(
      Math.max(...Object.values(categoryCounts)) - Math.min(...Object.values(categoryCounts)),
    ).toBeLessThanOrEqual(1);
  });

  test("uses every configured cross-list as an allocation option without starving a category", async () => {
    httpTextMock.mockResolvedValue(crossListedFairnessFeed());

    const result = await fetchArxiv();
    const counts = result.reduce<Record<string, number>>((byCategory, item) => {
      const category = String(item.signals.category);
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      return byCategory;
    }, {});

    expect(result).toHaveLength(PER_SOURCE_LIMIT.arxiv);
    expect(Object.keys(counts).sort()).toEqual([...ARXIV_CATEGORIES].sort());
    expect(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts))).toBeLessThanOrEqual(1);
  });

  test("reassigns earlier cross-lists when a feasible allocation would otherwise starve a category", async () => {
    httpTextMock.mockResolvedValue(`
      <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
        <channel>
          ${rssItem("2607.00101", "cs.AI", 101)}
          ${rssItem("2607.00102", ["cs.CL", "cs.LG"], 102)}
          ${rssItem("2607.00103", ["cs.AI", "cs.CL"], 103)}
        </channel>
      </rss>`,
    );

    const result = await fetchArxiv();

    expect(result).toHaveLength(3);
    expect(Object.fromEntries(result.map((item) => [item.externalId, item.signals.category]))).toEqual({
      "2607.00101": "cs.AI",
      "2607.00102": "cs.LG",
      "2607.00103": "cs.CL",
    });
  });

  test("covers every category for every three-paper cross-list graph with a complete matching", async () => {
    const targetCategories = ["cs.AI", "cs.CL", "cs.LG"];
    const labelOptions = [
      ["cs.AI"],
      ["cs.CL"],
      ["cs.LG"],
      ["cs.AI", "cs.CL"],
      ["cs.AI", "cs.LG"],
      ["cs.CL", "cs.LG"],
      ["cs.AI", "cs.CL", "cs.LG"],
    ];
    const hasCompleteMatching = (
      labelsByPaper: string[][],
      categoryIndex = 0,
      usedPapers = new Set<number>(),
    ): boolean => {
      if (categoryIndex === targetCategories.length) return true;
      return labelsByPaper.some(
        (labels, paperIndex) =>
          !usedPapers.has(paperIndex) &&
          labels.includes(targetCategories[categoryIndex]) &&
          hasCompleteMatching(
            labelsByPaper,
            categoryIndex + 1,
            new Set([...usedPapers, paperIndex]),
          ),
      );
    };

    for (const first of labelOptions) {
      for (const second of labelOptions) {
        for (const third of labelOptions) {
          const labelsByPaper = [first, second, third];
          if (!hasCompleteMatching(labelsByPaper)) continue;
          httpTextMock.mockResolvedValueOnce(`
            <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
              <channel>
                ${rssItem("2607.00201", first, 201)}
                ${rssItem("2607.00202", second, 202)}
                ${rssItem("2607.00203", third, 203)}
              </channel>
            </rss>`,
          );

          const assigned = new Set((await fetchArxiv()).map((item) => item.signals.category));
          expect(assigned, JSON.stringify(labelsByPaper)).toEqual(new Set(targetCategories));
        }
      }
    }
  });

  test("normalizes RSS IDs, URLs and dates while filtering duplicates and replace variants", async () => {
    httpTextMock.mockResolvedValue(await fixture("mixed.rss.xml"));

    const result = await fetchArxiv();

    expect(result.map(({ externalId }) => externalId).sort()).toEqual([
      "2401.01234",
      "hep-th/9901001",
    ]);
    expect(new Set(result.map(({ externalId }) => externalId)).size).toBe(result.length);
    expect(
      result.every(({ publishedAt }) => publishedAt === new Date(publishedAt).toISOString()),
    ).toBe(true);

    expect(result.find(({ externalId }) => externalId === "2401.01234")).toMatchObject({
      url: "https://arxiv.org/abs/2401.01234",
      authors: ["Ada Lovelace", "Alan Turing"],
      abstract: "A retrieval fixture abstract.",
      publishedAt: "2026-07-13T04:00:00.000Z",
      signals: { category: "cs.IR", announce: "new" },
    });
    expect(result.find(({ externalId }) => externalId === "hep-th/9901001")).toMatchObject({
      url: "https://arxiv.org/abs/hep-th/9901001",
      publishedAt: "2026-07-13T04:30:00.000Z",
    });
  });

  test("accepts Atom entries with canonical IDs and strict ISO publication times", async () => {
    httpTextMock.mockResolvedValue(await fixture("mixed.atom.xml"));

    const result = await fetchArxiv();

    expect(result.map(({ externalId }) => externalId).sort()).toEqual([
      "2101.00001",
      "math/0309136",
    ]);
    expect(result.find(({ externalId }) => externalId === "2101.00001")).toMatchObject({
      url: "https://arxiv.org/abs/2101.00001",
      title: "Atom Language Fixture",
      authors: ["Barbara Liskov", "Donald Knuth"],
      abstract: "An Atom summary.",
      publishedAt: "2026-07-13T05:00:00.000Z",
      signals: { category: "cs.CL" },
    });
    expect(result.find(({ externalId }) => externalId === "math/0309136")).toMatchObject({
      url: "https://arxiv.org/abs/math/0309136",
      publishedAt: "2026-07-13T07:00:00.000Z",
      signals: { category: "cs.MA" },
    });
  });

  test("filters an unlabelled Atom replacement by its version suffix", async () => {
    httpTextMock.mockResolvedValue(`
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/1706.03762v7</id>
          <published>2017-06-12T17:57:34Z</published>
          <updated>2023-08-25T15:46:26Z</updated>
          <title>Unlabelled Atom Replacement</title>
          <summary>This official-style Atom entry has no announce type.</summary>
          <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" />
          <arxiv:primary_category term="cs.CL" />
          <category term="cs.CL" />
        </entry>
      </feed>`);

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test("accepts a namespace-prefixed Atom feed", async () => {
    httpTextMock.mockResolvedValue(`
      <atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <atom:entry>
          <atom:id>http://arxiv.org/abs/2607.00001v1</atom:id>
          <atom:published>2026-07-13T05:00:00Z</atom:published>
          <atom:title>Prefixed Atom Fixture</atom:title>
          <atom:summary>A prefixed Atom summary.</atom:summary>
          <atom:author><atom:name>Frances Allen</atom:name></atom:author>
          <atom:link href="http://arxiv.org/abs/2607.00001v1" rel="alternate" />
          <arxiv:primary_category term="cs.AI" />
          <atom:category term="cs.AI" />
        </atom:entry>
      </atom:feed>`);

    await expect(fetchArxiv()).resolves.toEqual([
      expect.objectContaining({
        authors: ["Frances Allen"],
        externalId: "2607.00001",
        publishedAt: "2026-07-13T05:00:00.000Z",
        signals: expect.objectContaining({ category: "cs.AI" }),
        url: "https://arxiv.org/abs/2607.00001",
      }),
    ]);
  });

  test("ignores an arXiv-shaped path on an unrelated host and uses the trusted feed identity", async () => {
    httpTextMock.mockResolvedValue(`
      <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
        <channel><item>
          <title>Conflicting Link Fixture</title>
          <link>https://papers.example/abs/2607.99999v1</link>
          <description>arXiv:2607.00002v1 Announce Type: new Abstract: Trusted identity.</description>
          <guid isPermaLink="false">oai:arXiv.org:2607.00002v1</guid>
          <category>cs.AI</category>
          <pubDate>Mon, 13 Jul 2026 00:00:00 -0400</pubDate>
          <arxiv:announce_type>new</arxiv:announce_type>
        </item></channel>
      </rss>`);

    await expect(fetchArxiv()).resolves.toEqual([
      expect.objectContaining({
        externalId: "2607.00002",
        url: "https://arxiv.org/abs/2607.00002",
      }),
    ]);
  });

  test("does not infer the current paper identity from an abstract citation", async () => {
    httpTextMock.mockResolvedValue(`
      <rss xmlns:arxiv="http://arxiv.org/schemas/atom" version="2.0">
        <channel><item>
          <title>Missing Identity Fixture</title>
          <link>https://papers.example/no-paper-id</link>
          <description>Announce Type: new Abstract: This cites arXiv:2607.00004v1 but has no own ID.</description>
          <guid isPermaLink="false">not-an-arxiv-id</guid>
          <category>cs.AI</category>
          <pubDate>Mon, 13 Jul 2026 00:00:00 -0400</pubDate>
          <arxiv:announce_type>new</arxiv:announce_type>
        </item></channel>
      </rss>`);

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test("rejects impossible calendar dates instead of normalizing them into a different day", async () => {
    httpTextMock.mockResolvedValue(`
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2607.00003v1</id>
          <published>2026-02-30T00:00:00Z</published>
          <title>Impossible Date Fixture</title>
          <summary>Invalid date.</summary>
          <arxiv:primary_category term="cs.LG" />
          <category term="cs.LG" />
        </entry>
      </feed>`);

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test.each([
    ["without an explicit timezone", "2026-07-13T05:00:00"],
    ["beyond the positive ISO offset limit", "2026-07-13T05:00:00+14:01"],
    ["beyond the negative ISO offset limit", "2026-07-13T05:00:00-14:30"],
  ])("rejects an Atom timestamp %s", async (_name, publishedAt) => {
    httpTextMock.mockResolvedValue(`
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2607.00005v1</id>
          <published>${publishedAt}</published>
          <title>Timezone-free Date Fixture</title>
          <summary>Ambiguous local time.</summary>
          <arxiv:primary_category term="cs.LG" />
          <category term="cs.LG" />
        </entry>
      </feed>`);

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test("rejects an RSS publication time without an explicit timezone", async () => {
    httpTextMock.mockResolvedValue(`
      <rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
        <channel>${rssItem("2607.00006", "cs.AI", 6).replace(" -0400", "")}</channel>
      </rss>`,
    );

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test.each([
    [
      "RSS item fields",
      '<rss version="2.0"><channel><item><headline>Moved title</headline><released>2026-07-13</released></item></channel></rss>',
    ],
    [
      "Atom entry fields",
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><headline>Moved title</headline><released>2026-07-13</released></entry></feed>',
    ],
  ])("rejects a recognized root when non-empty %s drift from the supported schema", async (_name, xml) => {
    httpTextMock.mockResolvedValue(xml);

    await expect(fetchArxiv()).rejects.toThrow(/arXiv feed.*schema/i);
  });

  test.each([
    [
      "RSS",
      `<rss xmlns:arxiv="http://arxiv.org/schemas/atom" version="2.0"><channel>
        ${rssItem("2607.00301", "cs.AI", 301)}
        <item><headline>Moved title</headline><released>2026-07-13</released></item>
      </channel></rss>`,
    ],
    [
      "Atom",
      `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2607.00302v1</id>
          <published>2026-07-13T05:00:00Z</published>
          <title>Valid sibling</title><summary>Valid.</summary>
          <arxiv:primary_category term="cs.AI" /><category term="cs.AI" />
        </entry>
        <entry><headline>Moved title</headline><released>2026-07-13</released></entry>
      </feed>`,
    ],
  ])("rejects a mixed %s batch containing a schema-drifted entry", async (_name, xml) => {
    httpTextMock.mockResolvedValue(xml);

    await expect(fetchArxiv()).rejects.toThrow(/arXiv feed.*schema/i);
  });

  test.each([
    ["empty body", ""],
    ["truncated XML", "<rss><channel><item>"],
    ["wrong root", "<error>rate limited</error>"],
    ["RSS root without a channel", '<rss version="2.0"><item /></rss>'],
  ])("rejects %s instead of reporting a normal empty feed", async (_name, xml) => {
    httpTextMock.mockResolvedValue(xml);

    await expect(fetchArxiv()).rejects.toThrow(/arXiv feed/i);
  });

  test("accepts a structurally valid feed with no entries", async () => {
    httpTextMock.mockResolvedValue(
      '<rss version="2.0"><channel><title>No new papers</title></channel></rss>',
    );

    await expect(fetchArxiv()).resolves.toEqual([]);
  });

  test("propagates the single official-feed request failure", async () => {
    const failure = new Error("provider unavailable");
    httpTextMock.mockRejectedValue(failure);

    await expect(fetchArxiv()).rejects.toBe(failure);
    expect(httpTextMock).toHaveBeenCalledTimes(1);
  });
});
