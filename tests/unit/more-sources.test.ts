import { describe, expect, it } from "vitest";
import { detectIdentifier, identifierUrl } from "@/lib/identifiers";
import { epmcQuery, jatsSections, mapEpmcResult } from "@/server/scholarly/providers/europepmc";
import { mapOrNote, venueYear } from "@/server/scholarly/providers/openreview";
import { pmcidFromUrl, unpaywallPdfUrls, unpaywallResult } from "@/server/scholarly/providers/unpaywall";

describe("Europe PMC", () => {
  it("maps a PubMed record with its PMC id, open-access PDF and authors", () => {
    const p = mapEpmcResult({
      id: "38253604",
      source: "MED",
      pmid: "38253604",
      pmcid: "PMC10803759",
      doi: "10.1038/S41467-024-44824-Z",
      title: "Segment anything in medical images.",
      authorList: {
        author: [{ fullName: "Ma J", authorId: { type: "ORCID", value: "0000-0001" } }, { fullName: "He Y" }],
      },
      journalInfo: { journal: { title: "Nature communications" } },
      pubYear: "2024",
      firstPublicationDate: "2024-01-22",
      abstractText: "<h4>Background</h4>Medical image <i>segmentation</i> is critical.",
      pubTypeList: { pubType: ["research-article", "Journal Article"] },
      isOpenAccess: "Y",
      citedByCount: 1079,
      fullTextUrlList: {
        fullTextUrl: [
          {
            availabilityCode: "OA",
            documentStyle: "pdf",
            url: "https://europepmc.org/articles/PMC10803759?pdf=render",
          },
          { availabilityCode: "OA", documentStyle: "pdf", url: "https://www.nature.com/articles/x.pdf" },
        ],
      },
    })!;
    expect(p.source).toBe("europepmc");
    expect(p.ids).toEqual({ doi: "10.1038/s41467-024-44824-z", pmid: "38253604", pmcid: "PMC10803759" });
    expect(p.title).toBe("Segment anything in medical images");
    expect(p.abstract).toBe("Background Medical image segmentation is critical.");
    expect(p.authors[0]).toEqual({ name: "Ma J", ids: { orcid: "0000-0001" } });
    expect(p.publicationTypes).toEqual(["journal_article"]);
    expect(p.citationCount).toBe(1079);
    // The Europe PMC "render" link is bot-protected; the publisher PDF is used instead.
    expect(p.openAccessPdfUrl).toBe("https://www.nature.com/articles/x.pdf");
    expect(p.url).toBe("https://europepmc.org/article/MED/38253604");
  });

  it("maps preprints and skips records without identifiers", () => {
    const pre = mapEpmcResult({
      id: "PPR1",
      source: "PPR",
      doi: "10.1101/2026.01.01.1",
      title: "A preprint",
      authorString: "A B, C D.",
    });
    expect(pre?.publicationTypes).toEqual(["preprint"]);
    expect(pre?.authors.map((a) => a.name)).toEqual(["A B", "C D"]);
    expect(mapEpmcResult({ id: "x", source: "AGR", title: "No ids" })).toBeNull();
  });

  it("builds queries with filters and escapes field syntax", () => {
    expect(
      epmcQuery({
        query: 'tumor: "segmentation" (MRI)',
        mode: "all",
        filters: { yearFrom: 2020, openAccessOnly: true, minCitations: 5, publicationType: "review" },
        offset: 0,
        limit: 20,
      }),
    ).toBe(
      'TITLE_ABS:(tumor AND segmentation AND MRI) AND PUB_YEAR:[2020 TO 3000] AND OPEN_ACCESS:y AND CITED:[5 TO *] AND PUB_TYPE:"review"',
    );
    // The wider form (when titles and abstracts find too little) searches full texts.
    expect(
      epmcQuery({ query: "tumor segmentation", mode: "all", filters: {}, offset: 0, limit: 20, scope: "fulltext" }),
    ).toBe("(tumor segmentation)");
    expect(epmcQuery({ query: "Smith J", mode: "author", filters: {}, offset: 0, limit: 10 })).toBe('AUTH:"Smith J"');
  });

  it("extracts readable sections from JATS full text", () => {
    const xml = `<article><front><abstract><p>We segment organs.</p></abstract></front><body>
      <sec><title>Introduction</title><p>Medical image segmentation is a core task in clinical workflows, see <xref ref-type="bibr">1</xref>.</p></sec>
      <sec><title>Methods</title><p>We fine-tune a promptable segmentation model on one million image-mask pairs.</p>
      <table-wrap><table><tr><td>secret table</td></tr></table></table-wrap></sec></body></article>`;
    const sections = jatsSections(xml);
    expect(sections[0]).toContain(
      "Introduction\nMedical image segmentation is a core task in clinical workflows, see 1.",
    );
    expect(sections[1]).toContain("Methods");
    expect(sections.join(" ")).not.toContain("secret table");
  });
});

describe("OpenReview", () => {
  const note = (venue: string) => ({
    id: "abc123XYZ",
    forum: "abc123XYZ",
    pdate: Date.UTC(2025, 0, 22),
    content: {
      title: { value: "Diffusion Policy Policy Optimization" },
      abstract: { value: "We introduce DPPO." },
      authors: { value: ["Allen Z. Ren", "Justin Lidard"] },
      venue: { value: venue },
      pdf: { value: "/pdf/x.pdf" },
    },
  });

  it("maps a forum with venue, year and accept status", () => {
    const p = mapOrNote(note("ICLR 2025 Poster"))!;
    expect(p).toMatchObject({
      source: "openreview",
      ids: { openreview: "abc123XYZ" },
      venue: "ICLR 2025 Poster",
      year: 2025,
      publicationDate: "2025-01-22",
      publicationTypes: ["conference"],
      url: "https://openreview.net/forum?id=abc123XYZ",
    });
    expect(p.authors.map((a) => a.name)).toEqual(["Allen Z. Ren", "Justin Lidard"]);
    expect(mapOrNote(note("Submitted to ICLR 2024"))?.publicationTypes).toEqual(["preprint"]);
    expect(venueYear("NeurIPS 2023 oral", null)).toBe(2023);
  });

  it("recognizes OpenReview links", () => {
    expect(detectIdentifier("https://openreview.net/forum?id=mEpqHvbD2h")).toEqual({
      kind: "openreview",
      value: "mEpqHvbD2h",
    });
    expect(detectIdentifier("https://openreview.net/pdf?id=mEpqHvbD2h")).toEqual({
      kind: "openreview",
      value: "mEpqHvbD2h",
    });
    expect(identifierUrl("openreview", "x1y2z3")).toBe("https://openreview.net/forum?id=x1y2z3");
  });
});

describe("Unpaywall", () => {
  it("lists direct PDF links, best location first and publishers before repositories", () => {
    expect(
      unpaywallPdfUrls({
        is_oa: true,
        best_oa_location: { url_for_pdf: "http://www.thelancet.com/x/pdf", host_type: "publisher" },
        oa_locations: [
          { url_for_pdf: "https://repo.org/a.pdf", host_type: "repository" },
          { url_for_pdf: null, host_type: "repository" },
          { url_for_pdf: "http://www.thelancet.com/x/pdf", host_type: "publisher" },
        ],
      }),
    ).toEqual(["https://www.thelancet.com/x/pdf", "https://repo.org/a.pdf"]);
    expect(unpaywallPdfUrls({ is_oa: false, oa_locations: [{ url_for_pdf: "https://x.pdf" }] })).toEqual([]);
    expect(unpaywallPdfUrls(null)).toEqual([]);
  });

  it("keeps the free-to-read page when there is no PDF, and finds PubMed Central ids", () => {
    const green = unpaywallResult({
      is_oa: true,
      best_oa_location: { url_for_pdf: null, url: "http://www.ncbi.nlm.nih.gov/pmc/articles/5390933" },
    });
    expect(green).toEqual({ pdfs: [], freeReadUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5390933/" });
    const repository = unpaywallResult({ is_oa: true, best_oa_location: { url: "http://repo.example/item/1" } });
    expect(repository.freeReadUrl).toBe("https://repo.example/item/1");
    expect(
      unpaywallResult({ is_oa: true, best_oa_location: { url_for_pdf: "https://a/x.pdf", url: "https://a/x" } }),
    ).toEqual({ pdfs: ["https://a/x.pdf"], freeReadUrl: null });
    expect(unpaywallResult({ is_oa: false, best_oa_location: { url: "https://a/x" } }).freeReadUrl).toBeNull();
    expect(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8574196/")).toBe("PMC8574196");
    expect(pmcidFromUrl("https://pmc.ncbi.nlm.nih.gov/articles/pmc8574196")).toBe("PMC8574196");
    expect(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/5390933")).toBe("PMC5390933");
    expect(pmcidFromUrl("https://journal.example/articles/PMC1")).toBeNull();
  });
});

describe("OpenReview venue ranking", () => {
  it("prefers main-venue acceptances over workshops, submissions and withdrawals", async () => {
    const { venueRank } = await import("@/server/scholarly/providers/openreview");
    expect(
      [
        "ICLR 2025 Poster",
        "LFDM",
        "CoRL 2024 Workshop MRM-D Oral",
        "Submitted to ICLR 2024",
        "ICLR 2025 Conference Withdrawn Submission",
      ].map(venueRank),
    ).toEqual([0, 1, 1, 2, 3]);
  });

  it("recognises papers still under double-blind review", async () => {
    const { underReview, venueRank, mapOrNote } = await import("@/server/scholarly/providers/openreview");
    expect(underReview("ICLR 2027 Conference Submission")).toBe(true);
    expect(underReview("ICLR 2026 Poster")).toBe(false);
    expect(underReview("Submitted to ICLR 2025")).toBe(false);
    expect(venueRank("ICLR 2027 Conference Submission")).toBe(2);
    const p = mapOrNote({
      id: "abc",
      content: { title: { value: "An anonymous submission" }, venue: { value: "ICLR 2027 Conference Submission" } },
    } as never);
    expect(p?.publicationTypes).not.toContain("conference");
  });
});

describe("search quality helpers", () => {
  it("ranks Europe PMC matches by title words, then citations", async () => {
    const { rerank } = await import("@/server/scholarly/providers/europepmc");
    const p = (title: string, citationCount: number) => ({ title, citationCount }) as never;
    const ranked = rerank(
      [
        p("Organoids on a chip", 500),
        p("Cardiac MRI segmentation with deep learning", 3),
        p("Deep learning for cardiac MRI segmentation", 40),
      ],
      "cardiac MRI segmentation deep learning",
    ) as { title: string }[];
    expect(ranked.map((r) => r.title)).toEqual([
      "Deep learning for cardiac MRI segmentation",
      "Cardiac MRI segmentation with deep learning",
      "Organoids on a chip",
    ]);
  });

  it("drops affiliation text from author names", async () => {
    const { cleanAuthorName } = await import("@/server/scholarly/providers/openalex");
    expect(cleanAuthorName("Agustín Halty, 1 Facultad de Ingeniería, Universidad de la República")).toBe(
      "Agustín Halty",
    );
    expect(cleanAuthorName("Kaiming He")).toBe("Kaiming He");
    expect(cleanAuthorName("  ")).toBeNull();
  });

  it("retries a per-second rate limit before giving up", async () => {
    const { providerFetch } = await import("@/server/scholarly/http");
    const { vi } = await import("vitest");
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "0.01" } }),
      Response.json({ ok: true }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );
    try {
      expect(
        await providerFetch("https://api.example/x", { provider: "semantic_scholar", retryShortLimit: true }),
      ).toEqual({ ok: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "0.01" } })),
      );
      await expect(
        providerFetch("https://api.example/x", { provider: "semantic_scholar", retryShortLimit: true }),
      ).rejects.toThrow(/rate limit/);
      // A long wait (a used-up daily quota) is not retried.
      const fetch = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "3600" } }));
      vi.stubGlobal("fetch", fetch);
      await expect(
        providerFetch("https://api.example/x", { provider: "openalex", retryShortLimit: true }),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
