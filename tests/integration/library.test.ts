import { beforeAll, describe, expect, it } from "vitest";
import { createNote } from "@/server/knowledge/notes";
import { listLibrary, removeFromLibrary, savePaper, setStatus } from "@/server/library/library";
import { addToCollection, createCollection, listCollections, listTags, tagPapers } from "@/server/library/organize";
import { listNotes } from "@/server/knowledge/notes";
import { discover } from "@/server/papers/discovery";
import { ingestPapers } from "@/server/papers/ingest";
import { getPaperDetail } from "@/server/papers/service";
import { createUser, FakeProvider, installFakeScholarly, paper } from "./helpers";

const corpus = [
  paper({
    title: "Spatial reasoning in vision language models",
    ids: { s2: "lib-1", doi: "10.1000/lib.1" },
    year: 2024,
    citationCount: 50,
  }),
  paper({
    title: "Metric depth estimation from a single image",
    ids: { s2: "lib-2", arxiv: "2402.00002" },
    year: 2023,
    citationCount: 300,
  }),
  paper({ title: "Benchmarks for spatial understanding", ids: { s2: "lib-3" }, year: 2025, citationCount: 5 }),
];

describe("discovery, library and organization", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    await installFakeScholarly(new FakeProvider("semantic_scholar", corpus));
    ctx = await createUser("Librarian");
  });

  it("searches scholarly sources and rewrites natural-language questions", async () => {
    const res = await discover(ctx.workspaceId, {
      q: "How good is spatial reasoning?",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 20,
    });
    expect(res.interpretedQuery).toBe("spatial reasoning");
    expect(res.items.map((p) => p.title)).toEqual([corpus[0].title]);
    const direct = await discover(ctx.workspaceId, { q: "spatial", mode: "all", filters: {}, offset: 0, limit: 20 });
    expect(direct.items.map((p) => p.title)).toEqual([corpus[0].title, corpus[2].title]);
    expect(direct.items[0].library).toBeNull();
  });

  it("resolves identifiers directly", async () => {
    const res = await discover(ctx.workspaceId, {
      q: "arXiv:2402.00002",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 20,
    });
    expect(res.provider).toBe("identifier");
    expect(res.items[0].title).toBe(corpus[1].title);
  });

  it("saves papers, tracks reading status, tags and collections", async () => {
    const found = await discover(ctx.workspaceId, { q: "spatial", mode: "all", filters: {}, offset: 0, limit: 20 });
    const [a, b] = found.items.map((p) => p.id);
    await savePaper(ctx.workspaceId, ctx.userId, a);
    await savePaper(ctx.workspaceId, ctx.userId, b);
    await setStatus(ctx.workspaceId, [a], "reading");

    await tagPapers(ctx.workspaceId, ctx.userId, [a, b], { names: ["VLM", "vlm", "Spatial"] });
    const tags = await listTags(ctx.workspaceId);
    expect(tags.map((t) => [t.name, t.paperCount])).toEqual([
      ["Spatial", 2],
      ["VLM", 2],
    ]);

    const coll = await createCollection(ctx.workspaceId, { name: "Thesis" });
    await addToCollection(ctx.workspaceId, ctx.userId, coll.id, [a]);
    await expect(createCollection(ctx.workspaceId, { name: "thesis" })).rejects.toThrow(/already exists/);
    expect((await listCollections(ctx.workspaceId))[0].paperCount).toBe(1);

    const all = await listLibrary(ctx.workspaceId, { status: "all", sort: "added_desc", offset: 0, limit: 50 });
    expect(all.total).toBe(2);
    expect(all.counts).toMatchObject({ all: 2, reading: 1, saved: 1 });
    const reading = await listLibrary(ctx.workspaceId, { status: "reading", sort: "added_desc", offset: 0, limit: 50 });
    expect(reading.items.map((i) => i.id)).toEqual([a]);
    const inColl = await listLibrary(ctx.workspaceId, {
      status: "all",
      collectionId: coll.id,
      sort: "added_desc",
      offset: 0,
      limit: 50,
    });
    expect(inColl.items[0].collections[0].name).toBe("Thesis");
    const filtered = await listLibrary(ctx.workspaceId, {
      status: "all",
      q: "benchmarks",
      sort: "added_desc",
      offset: 0,
      limit: 50,
    });
    expect(filtered.items.map((i) => i.id)).toEqual([b]);

    const detail = await getPaperDetail(ctx.workspaceId, a);
    expect(detail.library?.status).toBe("reading");
    expect(detail.tags.map((t) => t.name).sort()).toEqual(["Spatial", "VLM"]);
  });

  it("keeps notes when a paper is removed from the library", async () => {
    const found = await discover(ctx.workspaceId, {
      q: "metric depth",
      mode: "all",
      filters: {},
      offset: 0,
      limit: 20,
    });
    const id = found.items[0].id;
    await savePaper(ctx.workspaceId, ctx.userId, id);
    await createNote(ctx, { title: "Depth thoughts", paperId: id });
    await removeFromLibrary(ctx.workspaceId, [id]);
    expect((await getPaperDetail(ctx.workspaceId, id)).library).toBeNull();
    expect((await listNotes(ctx.workspaceId, { paperId: id })).map((n) => n.title)).toEqual(["Depth thoughts"]);
  });

  it("isolates workspaces", async () => {
    const other = await createUser("Other");
    const res = await listLibrary(other.workspaceId, { status: "all", sort: "added_desc", offset: 0, limit: 50 });
    expect(res.total).toBe(0);
    expect(await listTags(other.workspaceId)).toEqual([]);
  });
});

describe("library filters across workspaces", () => {
  it("ignores another workspace's collection and tag ids", async () => {
    const owner = await createUser("Filter owner");
    const other = await createUser("Filter observer");
    const [id] = await ingestPapers([paper({ title: "Collection membership probe paper", ids: { s2: "lib-oracle" } })]);
    const collection = await createCollection(owner.workspaceId, { name: "Secret shortlist" });
    await addToCollection(owner.workspaceId, owner.userId, collection.id, [id]);
    await tagPapers(owner.workspaceId, owner.userId, [id], { names: ["secret-tag"] });
    const [tag] = await listTags(owner.workspaceId);
    await savePaper(other.workspaceId, other.userId, id);
    const base = { status: "all", sort: "added_desc", offset: 0, limit: 20 } as const;
    expect((await listLibrary(other.workspaceId, { ...base, collectionId: collection.id })).items).toEqual([]);
    expect((await listLibrary(other.workspaceId, { ...base, tagId: tag.id })).items).toEqual([]);
    expect((await listLibrary(owner.workspaceId, { ...base, collectionId: collection.id })).items).toHaveLength(1);
  });
});
