import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { closeDb, db } from "@/server/db/client";
import { externalCache, users } from "@/server/db/schema";
import type { RequestContext } from "@/server/http";
import { ScholarlyService, setScholarlyServiceForTests } from "@/server/scholarly/service";
import {
  ProviderError,
  type CitationPage,
  type IdentifierKind,
  type NormalizedPaper,
  type PaperRef,
  type ProviderName,
  type ScholarlyProvider,
  type SearchPage,
  type SearchRequest,
} from "@/server/scholarly/types";
import { createPersonalWorkspace } from "@/server/workspaces";

afterAll(async () => {
  setScholarlyServiceForTests(undefined);
  await closeDb();
});

export async function createUser(name = "Tester"): Promise<RequestContext> {
  const id = randomUUID();
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${id.slice(0, 8)}@example.com`;
  await db.insert(users).values({ id, name, email });
  const ws = await createPersonalWorkspace(id, name);
  return { userId: id, userName: name, userEmail: email, workspaceId: ws.id, role: "owner" };
}

export function paper(
  overrides: Partial<NormalizedPaper> & { ids: NormalizedPaper["ids"]; title: string },
): NormalizedPaper {
  return {
    source: "semantic_scholar",
    abstract: `Abstract of ${overrides.title}`,
    year: 2020,
    publicationDate: null,
    venue: "Test Venue",
    publicationTypes: ["journal_article"],
    fieldsOfStudy: [],
    authors: [{ name: "Ada Lovelace" }],
    citationCount: 10,
    referenceCount: 2,
    influentialCitationCount: null,
    isOpenAccess: null,
    openAccessPdfUrl: null,
    url: null,
    ...overrides,
  };
}

/** In-memory scholarly source. `cites` maps a paper's s2 id to the s2 ids it references. */
export class FakeProvider implements ScholarlyProvider {
  readonly lookupKinds: readonly IdentifierKind[] = ["s2", "doi", "arxiv"];
  readonly supportsSearch = true;
  readonly supportsCitations = true;
  calls = 0;
  failWith: ProviderError["kind"] | null = null;

  constructor(
    readonly name: ProviderName,
    private readonly papers: NormalizedPaper[],
    private readonly cites: Record<string, string[]> = {},
  ) {}

  private guard() {
    this.calls++;
    if (this.failWith) throw new ProviderError(this.name, this.failWith, `${this.name} failed`);
  }

  private find(ref: PaperRef) {
    return this.papers.find((p) => p.ids[ref.kind] === ref.value) ?? null;
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    this.guard();
    const words = req.query.toLowerCase().split(/\s+/);
    const hits = this.papers.filter((p) =>
      words.every((w) => `${p.title} ${p.authors.map((a) => a.name).join(" ")}`.toLowerCase().includes(w)),
    );
    if (req.sort === "newest") hits.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    if (req.sort === "citations") hits.sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
    return { provider: this.name, papers: hits.slice(req.offset, req.offset + req.limit), total: hits.length };
  }

  async getPaper(ref: PaperRef) {
    this.guard();
    return this.find(ref);
  }

  /** Newest papers matching every word (used when the fake plays arXiv). */
  async searchLatest(query: string, limit: number) {
    this.guard();
    const words = query.toLowerCase().split(/\s+/);
    return this.papers
      .filter((p) => words.every((w) => p.title.toLowerCase().includes(w)))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      .slice(0, limit);
  }

  async getReferences(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    this.guard();
    const p = this.find(ref);
    const refs = (this.cites[p?.ids.s2 ?? ""] ?? []).map((id) => this.papers.find((x) => x.ids.s2 === id)!);
    return {
      provider: this.name,
      entries: refs.slice(offset, offset + limit).map((paper) => ({
        paper,
        isInfluential: true,
        intents: ["methodology"],
        contexts: [`We build on ${paper.title}.`],
      })),
      total: refs.length,
      hasMore: offset + limit < refs.length,
    };
  }

  async getCitations(ref: PaperRef, offset: number, limit: number): Promise<CitationPage> {
    this.guard();
    const p = this.find(ref);
    const citing = Object.entries(this.cites)
      .filter(([, targets]) => targets.includes(p?.ids.s2 ?? ""))
      .map(([id]) => this.papers.find((x) => x.ids.s2 === id)!);
    return {
      provider: this.name,
      entries: citing
        .slice(offset, offset + limit)
        .map((paper) => ({ paper, isInfluential: null, intents: [], contexts: [] })),
      total: citing.length,
      hasMore: offset + limit < citing.length,
    };
  }
}

const noop = (name: ProviderName): ScholarlyProvider => ({
  name,
  lookupKinds: [],
  supportsSearch: false,
  supportsCitations: false,
  getPaper: async () => null,
});

/** Installs fake providers as the scholarly service, clearing cached external responses. */
export async function installFakeScholarly(...providers: ScholarlyProvider[]) {
  return installFakeScholarlyWith({}, ...providers);
}

export async function installFakeScholarlyWith(options: { contactEmail?: string }, ...providers: ScholarlyProvider[]) {
  await db.delete(externalCache);
  // Providers named "arxiv", "europepmc" and "openreview" play those sources; the others are the
  // general discovery sources.
  const special = new Set(["arxiv", "europepmc", "openreview"]);
  const byName = (name: string) => providers.find((p) => p.name === name);
  const service = new ScholarlyService(
    providers.filter((p) => !special.has(p.name)),
    {
      crossref: noop("crossref"),
      arxiv: byName("arxiv") ?? noop("arxiv"),
      biomedical: byName("europepmc"),
      openreview: byName("openreview"),
      contactEmail: options.contactEmail,
    },
    1,
  );
  setScholarlyServiceForTests(service);
  return service;
}

/** A minimal valid single-page PDF containing `text`. */
export function makePdf(text: string): Uint8Array<ArrayBuffer> {
  return makePdfPages([[text]]);
}

/** A minimal valid PDF: one entry per page, each a list of text lines (top to bottom). */
export function makePdfPages(pages: string[][]): Uint8Array<ArrayBuffer> {
  const n = pages.length;
  // Objects: 1 catalog, 2 pages, 3 font, then a page and its content stream for each page.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    const stream = lines
      .map((line, j) => `BT /F1 18 Tf 72 ${720 - j * 30} Td (${line.replace(/[()\\]/g, "")}) Tj ET`)
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
