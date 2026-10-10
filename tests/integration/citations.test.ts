import { beforeAll, describe, expect, it } from "vitest";
import { citationGraph } from "@/server/graph/citation-graph";
import { savePaper } from "@/server/library/library";
import { listCitationEdges } from "@/server/papers/citations";
import { discover } from "@/server/papers/discovery";
import { ScholarlyUnavailableError } from "@/server/scholarly/service";
import { createUser, FakeProvider, installFakeScholarly, paper } from "./helpers";

const corpus = [
  paper({ title: "Root paper on lineage", ids: { s2: "cit-root" }, year: 2022 }),
  paper({ title: "Older foundation A", ids: { s2: "cit-a" }, year: 2015, citationCount: 900 }),
  paper({ title: "Older foundation B", ids: { s2: "cit-b" }, year: 2016, citationCount: 50 }),
  paper({ title: "Follow-up work", ids: { s2: "cit-c" }, year: 2024 }),
];
const cites = { "cit-root": ["cit-a", "cit-b"], "cit-c": ["cit-root", "cit-a"], "cit-b": ["cit-a"] };

describe("references, citations and the citation graph", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let rootId: string;
  let primary: FakeProvider;
  let secondary: FakeProvider;

  beforeAll(async () => {
    primary = new FakeProvider("semantic_scholar", corpus, cites);
    secondary = new FakeProvider("openalex", corpus, cites);
    await installFakeScholarly(primary, secondary);
    ctx = await createUser("Lineage");
    rootId = (await discover(ctx.workspaceId, { q: "root paper", mode: "all", filters: {}, offset: 0, limit: 10 }))
      .items[0].id;
  });

  it("lists references with citation metadata from the source", async () => {
    const refs = await listCitationEdges(ctx.workspaceId, rootId, "references", 0);
    expect(refs.items.map((i) => i.paper?.title)).toEqual(["Older foundation A", "Older foundation B"]);
    expect(refs.items[0]).toMatchObject({
      isInfluential: true,
      intents: ["methodology"],
      contexts: ["We build on Older foundation A."],
    });
    expect(refs.total).toBe(2);
  });

  it("lists citing papers", async () => {
    const citing = await listCitationEdges(ctx.workspaceId, rootId, "citations", 0);
    expect(citing.items.map((i) => i.paper?.title)).toEqual(["Follow-up work"]);
  });

  it("builds a citation graph including edges among neighbors", async () => {
    await savePaper(ctx.workspaceId, ctx.userId, rootId);
    // Explore paper B once so its references (B cites A) become known.
    const refs = await listCitationEdges(ctx.workspaceId, rootId, "references", 0);
    await listCitationEdges(ctx.workspaceId, refs.items[1].paper!.id, "references", 0);
    const g = await citationGraph(ctx.workspaceId, rootId, { references: 10, citations: 10 });
    expect(g.nodes.find((n) => n.role === "center")?.entityId).toBe(rootId);
    expect(g.nodes.filter((n) => n.role === "reference")).toHaveLength(2);
    expect(g.nodes.filter((n) => n.role === "citation")).toHaveLength(1);
    const title = (id: string) => g.papers[id.replace("paper:", "")]?.title;
    const edges = g.edges.map((e) => `${title(e.source)} -> ${title(e.target)}`).sort();
    expect(edges).toContain("Older foundation B -> Older foundation A");
    expect(edges).toContain("Follow-up work -> Root paper on lineage");
    expect(g.nodes.find((n) => n.role === "center")?.status).toBe("saved");
    expect(g.partial).toBe(false);
  });

  it("fails over to the next provider when one is rate limited", async () => {
    await installFakeScholarly(primary, secondary);
    primary.failWith = "rate_limited";
    secondary.calls = 0;
    const res = await discover(ctx.workspaceId, { q: "follow-up", mode: "all", filters: {}, offset: 0, limit: 10 });
    expect(res.provider).toBe("openalex");
    expect(secondary.calls).toBe(1);
    // The rate-limited provider is now skipped without being called again.
    const before = primary.calls;
    await discover(ctx.workspaceId, { q: "older", mode: "all", filters: {}, offset: 0, limit: 10 });
    expect(primary.calls).toBe(before);
    primary.failWith = null;
  });

  it("reports an understandable error when every source fails", async () => {
    const a = new FakeProvider("semantic_scholar", corpus);
    const b = new FakeProvider("openalex", corpus);
    a.failWith = "unavailable";
    b.failWith = "rate_limited";
    await installFakeScholarly(a, b);
    const err = await discover(ctx.workspaceId, {
      q: "anything",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ScholarlyUnavailableError);
    expect(err.message).toMatch(/rate limiting/);
  });

  it("marks the citation graph as partial when sources are down", async () => {
    const down = new FakeProvider("semantic_scholar", corpus);
    down.failWith = "unavailable";
    await installFakeScholarly(down);
    const g = await citationGraph(ctx.workspaceId, rootId, { references: 5, citations: 5 });
    expect(g.partial).toBe(true);
    expect(g.nodes).toHaveLength(1);
  });
});

describe("duplicate citation entries", () => {
  it("combines entries that resolve to the same paper instead of failing", async () => {
    const dupCorpus = [
      paper({ title: "Paper with a duplicated reference", ids: { s2: "dup-root" }, year: 2023 }),
      paper({ title: "Referenced work", ids: { s2: "dup-a", doi: "10.1000/ref" }, year: 2020 }),
    ];
    const provider = new FakeProvider("semantic_scholar", dupCorpus, { "dup-root": ["dup-a", "dup-a"] });
    await installFakeScholarly(provider);
    const ctx = await createUser("Duplicates");
    const [root] = (
      await discover(ctx.workspaceId, { q: "duplicated reference", mode: "all", filters: {}, offset: 0, limit: 5 })
    ).items;
    const refs = await listCitationEdges(ctx.workspaceId, root.id, "references", 0);
    expect(refs.items.map((i) => i.paper?.title)).toEqual(["Referenced work"]);
  });
});
