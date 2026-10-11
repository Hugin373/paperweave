import { describe, expect, it } from "vitest";
import { pdfUrlVariants, serverCanFetchPdf } from "@/server/scholarly/free-pdf";
import { mapS2Paper } from "@/server/scholarly/providers/semantic-scholar";

describe("free PDF links", () => {
  it("tells downloadable PDFs from links only a browser can open", () => {
    expect(serverCanFetchPdf("https://arxiv.org/pdf/1706.03762")).toBe(true);
    expect(serverCanFetchPdf("https://www.nature.com/articles/s41598-024-1.pdf")).toBe(true);
    expect(serverCanFetchPdf("https://doi.org/10.1016/j.patrec.2025.11.027")).toBe(false);
    expect(serverCanFetchPdf("https://pmc.ncbi.nlm.nih.gov/articles/PMC13029012/pdf/nihms-1.pdf")).toBe(false);
    expect(serverCanFetchPdf("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/pdf/a.pdf")).toBe(false);
    expect(serverCanFetchPdf("https://europepmc.org/articles/PMC1?pdf=render")).toBe(false);
    expect(serverCanFetchPdf("https://europepmc.org/abstract/MED/1")).toBe(true);
    expect(serverCanFetchPdf("not a url")).toBe(false);
  });

  it("tries Nature's final PDF before its 'article in press' preview", () => {
    expect(pdfUrlVariants("https://www.nature.com/articles/s41398-026-03902-0_reference.pdf")).toEqual([
      "https://www.nature.com/articles/s41398-026-03902-0.pdf",
      "https://www.nature.com/articles/s41398-026-03902-0_reference.pdf",
    ]);
    expect(pdfUrlVariants("https://arxiv.org/pdf/1706.03762")).toEqual(["https://arxiv.org/pdf/1706.03762"]);
  });

  it("keeps a DOI link reported as the PDF as a read-free link instead", () => {
    const p = mapS2Paper({
      paperId: "abc",
      title: "Regional patch-based MRI brain age modeling",
      externalIds: { DOI: "10.1016/j.patrec.2025.11.027" },
      openAccessPdf: { url: "https://doi.org/10.1016/j.patrec.2025.11.027" },
    } as Parameters<typeof mapS2Paper>[0])!;
    expect(p.openAccessPdfUrl).toBeNull();
    expect(p.freeReadUrl).toBe("https://doi.org/10.1016/j.patrec.2025.11.027");
  });
});
