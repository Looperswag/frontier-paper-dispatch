import { expect, test } from "vitest";
import { mapOpenAlexWorks, openAlexWorksURL, validateOpenAlex } from "../../scripts/fetchers/openalex.ts";

test("OpenAlex query is bounded to recent AI works and excludes future publication dates", () => {
  const url = new URL(openAlexWorksURL(
    new Date("2026-07-15T12:00:00.000Z"),
    "openalex-private-key",
  ));
  expect(url.hostname).toBe("api.openalex.org");
  expect(url.searchParams.get("filter")).toContain("from_publication_date:2026-07-13");
  expect(url.searchParams.get("filter")).toContain("to_publication_date:2026-07-15");
  expect(url.searchParams.get("filter")).toContain("primary_topic.subfield.id:1702");
  expect(url.searchParams.get("per_page")).toBe("20");
  expect(url.searchParams.get("api_key")).toBe("openalex-private-key");
  expect(url.searchParams.get("select")).toBe(
    "id,doi,title,publication_date,authorships,cited_by_count,primary_location,primary_topic,abstract_inverted_index",
  );
});

test("OpenAlex anonymous compatibility never inserts a placeholder key", () => {
  const url = new URL(openAlexWorksURL(new Date("2026-07-15T12:00:00.000Z")));
  expect(url.searchParams.has("api_key")).toBe(false);
});

test("OpenAlex validates work shapes and maps bounded paper metadata", () => {
  expect(() => validateOpenAlex({ results: [null] })).toThrow(/invalid work/i);
  const response = validateOpenAlex({
    results: [{
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1000/test",
      title: "Agent paper",
      publication_date: "2026-07-15",
      authorships: [{ author: { display_name: "Alice" } }],
      cited_by_count: 4,
      primary_topic: { display_name: "Artificial intelligence", field: { id: "https://openalex.org/fields/17" } },
      primary_location: { landing_page_url: "https://example.org/paper" },
      abstract_inverted_index: { Agent: [0], paper: [1] },
    }],
  });
  expect(mapOpenAlexWorks(response, new Date("2026-07-15T12:00:00.000Z"))).toEqual([
    expect.objectContaining({
      source: "openalex",
      externalId: "https://doi.org/10.1000/test",
      title: "Agent paper",
      authors: ["Alice"],
      abstract: "Agent paper",
      signals: expect.objectContaining({ citations: 4, category: "Artificial intelligence" }),
    }),
  ]);
});

test("OpenAlex enforces local result bounds and rejects DOI lookalike identities", () => {
  const response = validateOpenAlex({
    results: Array.from({ length: 25 }, (_, index) => ({
      id: `https://openalex.org/W${index + 1}`,
      doi: index === 0 ? "https://doi.org.evil.test/10.1000/lookalike" : null,
      title: `Paper ${index + 1}`,
      publication_date: "2026-07-15",
      authorships: Array.from({ length: 60 }, (_unused, authorIndex) => ({
        author: { display_name: `Author ${authorIndex + 1}` },
      })),
      primary_location: {
        landing_page_url: index === 0 ? "javascript:alert(1)" : `https://publisher.example/paper-${index + 1}`,
      },
    })),
  });

  const items = mapOpenAlexWorks(response, new Date("2026-07-15T12:00:00.000Z"));
  expect(items).toHaveLength(20);
  expect(items[0]).toEqual(expect.objectContaining({
    externalId: "https://openalex.org/W1",
    url: "https://openalex.org/W1",
  }));
  expect(items.every((item) => item.authors.length <= 50)).toBe(true);
});
