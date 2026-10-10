import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openAccessCandidates } from "@/server/files/service";
import { listCitationEdges } from "@/server/papers/citations";
import { discover } from "@/server/papers/discovery";
import { getPaperDetail } from "@/server/papers/service";
import { createUser, FakeProvider, installFakeScholarlyWith, paper } from "./helpers";

const general = [paper({ title: "Tumor segmentation with transformers", ids: { s2: "g-1", doi: "10.1000/tumor" } })];
const biomedical = [
  paper({
    title: "Tumor segmentation in clinical MRI",
    ids: { pmid: "111", doi: "10.1000/clinical", s2: "bio-111" },
    year: 2024,
  }),
  paper({ title: "Citing tumor study", ids: { pmid: "222", s2: "bio-222" }, year: 2025 }),
];
const openreview = [paper({ title: "Tumor segmentation benchmark", ids: { openreview: "orTumor1" }, year: 2025 })];

describe("biomedical and OpenReview sources, Unpaywall", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  const search = (source: "general" | "biomedical" | "openreview") =>
    discover(ctx.workspaceId, { q: "tumor segmentation", mode: "all", filters: {}, offset: 0, limit: 10, source });

  beforeAll(async () => {
    const s2 = new FakeProvider("semantic_scholar", general);
    s2.failWith = null;
    await installFakeScholarlyWith(
      { contactEmail: "me@example.org" },
      s2,
      new FakeProvider("europepmc", biomedical, { "bio-222": ["bio-111"] }),
      new FakeProvider("openreview", openreview),
    );
    ctx = await createUser("Clinician");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("searches the chosen source", async () => {
    expect((await search("general")).items.map((p) => p.title)).toEqual(["Tumor segmentation with transformers"]);
    const bio = await search("biomedical");
    expect(bio.provider).toBe("europepmc");
    expect(bio.items.map((p) => p.title)).toEqual(["Tumor segmentation in clinical MRI"]);
    expect((await search("openreview")).items.map((p) => p.ids.openreview)).toEqual(["orTumor1"]);
  });

  it("finds free PDFs through Unpaywall by DOI, and offers to look for them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (!url.startsWith("https://api.unpaywall.org/v2/10.1000%2Fclinical?email=me%40example.org")) {
          return new Response("unexpected", { status: 500 });
        }
        return Response.json({
          is_oa: true,
          best_oa_location: { url_for_pdf: "https://publisher.example/clinical.pdf", host_type: "publisher" },
          oa_locations: [{ url_for_pdf: "https://repo.example/clinical.pdf", host_type: "repository" }],
        });
      }),
    );
    const [p] = (await search("biomedical")).items;
    expect(await openAccessCandidates(ctx.workspaceId, p.id)).toEqual([
      { kind: "url", url: "https://publisher.example/clinical.pdf" },
      { kind: "url", url: "https://repo.example/clinical.pdf" },
    ]);
    const detail = await getPaperDetail(ctx.workspaceId, p.id);
    expect(detail.openAccessPdfUrl).toBeNull();
    // No link is on record yet: the background check (see open-access.test.ts) fills it in.
    expect(detail.pdfAvailable).toBe(false);
  });

  it("lists citations of PubMed papers through Europe PMC when the main sources have none", async () => {
    const [p] = (await search("biomedical")).items;
    const cites = await listCitationEdges(ctx.workspaceId, p.id, "citations", 0);
    expect(cites.provider).toBe("europepmc");
    expect(cites.items.map((i) => i.paper?.title)).toEqual(["Citing tumor study"]);
  });
});
