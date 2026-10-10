/**
 * The personal knowledge graph: library papers, concepts and notes, connected by
 * citations (scholarly data) and user-created links. Built on demand from relational
 * tables — no separate graph store.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { GraphEdge, GraphEdgeType, GraphNode, GraphNodeType, GraphResponse } from "@/lib/types";
import { db } from "@/server/db/client";
import {
  citations,
  collectionPapers,
  collections,
  conceptRelations,
  concepts,
  libraryItems,
  noteLinks,
  notes,
  paperConcepts,
  papers,
} from "@/server/db/schema";

const MAX_NODES = 600;

export interface GraphOptions {
  includeArchived?: boolean;
  collectionId?: string;
  includeCitations?: boolean;
}

interface RawGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

const nid = (type: GraphNodeType, id: string) => `${type}:${id}`;

function addEdge(g: RawGraph, type: GraphEdgeType, source: string, target: string) {
  if (source === target || !g.nodes.has(source) || !g.nodes.has(target)) return;
  g.edges.push({ id: `${type}:${source}->${target}`, type, source, target });
}

function shortAuthors(authorsText: string) {
  const list = authorsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return "";
  const family = list[0].split(/\s+/).at(-1);
  return list.length > 1 ? `${family} et al.` : (family ?? "");
}

/** The workspace's collection memberships (fetched alongside the graph, applied by `withCollections`). */
type Memberships = { paperId: string; id: string; name: string; color: string | null }[];

function collectionMemberships(workspaceId: string): Promise<Memberships> {
  return db
    .select({ paperId: collectionPapers.paperId, id: collections.id, name: collections.name, color: collections.color })
    .from(collectionPapers)
    .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
    .where(eq(collections.workspaceId, workspaceId))
    .orderBy(collections.name);
}

/**
 * Loads the workspace's knowledge graph in two rounds of parallel queries: against a cloud database each
 * round trip costs ~70 ms, so the queries that do not depend on each other run together.
 */
async function loadWorkspaceGraph(workspaceId: string, opts: GraphOptions): Promise<RawGraph> {
  const g: RawGraph = { nodes: new Map(), edges: [] };
  const workspaceConcepts = db.select({ id: concepts.id }).from(concepts).where(eq(concepts.workspaceId, workspaceId));

  const [paperRows, conceptRows, noteRows, linkRows, pc, cr] = await Promise.all([
    db
      .select({
        id: papers.id,
        title: papers.title,
        year: papers.year,
        authorsText: papers.authorsText,
        citationCount: papers.citationCount,
        status: libraryItems.status,
      })
      .from(libraryItems)
      .innerJoin(papers, eq(papers.id, libraryItems.paperId))
      .where(
        and(
          eq(libraryItems.workspaceId, workspaceId),
          opts.includeArchived ? undefined : sql`${libraryItems.status} <> 'archived'`,
          opts.collectionId
            ? inArray(
                papers.id,
                db
                  .select({ id: collectionPapers.paperId })
                  .from(collectionPapers)
                  .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
                  .where(
                    and(eq(collectionPapers.collectionId, opts.collectionId), eq(collections.workspaceId, workspaceId)),
                  ),
              )
            : undefined,
        ),
      ),
    db.select({ id: concepts.id, name: concepts.name }).from(concepts).where(eq(concepts.workspaceId, workspaceId)),
    db
      .select({ id: notes.id, title: notes.title, paperId: notes.paperId })
      .from(notes)
      .where(eq(notes.workspaceId, workspaceId)),
    db
      .select({
        noteId: noteLinks.noteId,
        paperId: noteLinks.targetPaperId,
        conceptId: noteLinks.targetConceptId,
        targetNoteId: noteLinks.targetNoteId,
      })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.noteId))
      .where(eq(notes.workspaceId, workspaceId)),
    db
      .select({ conceptId: paperConcepts.conceptId, paperId: paperConcepts.paperId })
      .from(paperConcepts)
      .where(inArray(paperConcepts.conceptId, workspaceConcepts)),
    db
      .select({ a: conceptRelations.conceptAId, b: conceptRelations.conceptBId })
      .from(conceptRelations)
      .where(
        or(
          inArray(conceptRelations.conceptAId, workspaceConcepts),
          inArray(conceptRelations.conceptBId, workspaceConcepts),
        ),
      ),
  ]);

  for (const p of paperRows) {
    g.nodes.set(nid("paper", p.id), {
      id: nid("paper", p.id),
      type: "paper",
      entityId: p.id,
      label: p.title,
      sublabel: [shortAuthors(p.authorsText), p.year].filter(Boolean).join(", "),
      status: p.status,
      citationCount: p.citationCount,
      year: p.year,
    });
  }
  for (const c of conceptRows) {
    g.nodes.set(nid("concept", c.id), { id: nid("concept", c.id), type: "concept", entityId: c.id, label: c.name });
  }
  for (const n of noteRows) {
    g.nodes.set(nid("note", n.id), {
      id: nid("note", n.id),
      type: "note",
      entityId: n.id,
      label: n.title || "Untitled note",
    });
  }

  // Papers referenced by notes but not in the library (e.g. a note on a paper that was removed), and the
  // citations among all the graph's papers.
  const extraPaperIds = [
    ...new Set(
      [...linkRows.map((l) => l.paperId), ...noteRows.map((n) => n.paperId)].filter(
        (id): id is string => !!id && !g.nodes.has(nid("paper", id)),
      ),
    ),
  ];
  const withExtra = extraPaperIds.length && !opts.collectionId;
  const allPaperIds = [...paperRows.map((p) => p.id), ...(withExtra ? extraPaperIds : [])];
  const [extra, cites] = await Promise.all([
    withExtra
      ? db
          .select({ id: papers.id, title: papers.title, year: papers.year, authorsText: papers.authorsText })
          .from(papers)
          .where(inArray(papers.id, extraPaperIds))
      : [],
    opts.includeCitations !== false && allPaperIds.length > 1
      ? db
          .select({ citing: citations.citingPaperId, cited: citations.citedPaperId })
          .from(citations)
          .where(and(inArray(citations.citingPaperId, allPaperIds), inArray(citations.citedPaperId, allPaperIds)))
      : [],
  ]);
  for (const p of extra) {
    g.nodes.set(nid("paper", p.id), {
      id: nid("paper", p.id),
      type: "paper",
      entityId: p.id,
      label: p.title,
      sublabel: [shortAuthors(p.authorsText), p.year].filter(Boolean).join(", "),
      status: null,
      year: p.year,
    });
  }

  for (const n of noteRows) if (n.paperId) addEdge(g, "note_about_paper", nid("note", n.id), nid("paper", n.paperId));
  for (const l of linkRows) {
    const src = nid("note", l.noteId);
    if (l.paperId) addEdge(g, "note_paper", src, nid("paper", l.paperId));
    if (l.conceptId) addEdge(g, "note_concept", src, nid("concept", l.conceptId));
    if (l.targetNoteId) addEdge(g, "note_note", src, nid("note", l.targetNoteId));
  }
  for (const r of pc) addEdge(g, "paper_concept", nid("paper", r.paperId), nid("concept", r.conceptId));
  for (const r of cr) addEdge(g, "concept_concept", nid("concept", r.a), nid("concept", r.b));
  for (const c of cites) addEdge(g, "cites", nid("paper", c.citing), nid("paper", c.cited));

  if (opts.collectionId) {
    // In a collection view, only keep concepts/notes connected to the collection's papers.
    const keep = new Set<string>([...g.nodes.values()].filter((n) => n.type === "paper").map((n) => n.id));
    for (const e of g.edges) {
      if (keep.has(e.source) || keep.has(e.target)) {
        keep.add(e.source);
        keep.add(e.target);
      }
    }
    return prune(g, keep);
  }
  return g;
}

function prune(g: RawGraph, keep: Set<string>): RawGraph {
  return {
    nodes: new Map([...g.nodes].filter(([id]) => keep.has(id))),
    edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

function finalize(g: RawGraph, limit = MAX_NODES): GraphResponse {
  let nodes = [...g.nodes.values()];
  let truncated = false;
  if (nodes.length > limit) {
    // Keep the most connected nodes.
    const degree = new Map<string, number>();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    nodes = nodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, limit);
    truncated = true;
  }
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges = g.edges.filter((e) => {
    if (!ids.has(e.source) || !ids.has(e.target) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return { nodes, edges, truncated };
}

/** Adds each paper's collections (in this workspace) and the list of those collections. */
async function withCollections(
  workspaceId: string,
  graph: GraphResponse,
  memberships?: Promise<Memberships>,
): Promise<GraphResponse> {
  const inGraph = new Set(graph.nodes.filter((n) => n.type === "paper").map((n) => n.entityId));
  if (!inGraph.size) return { ...graph, collections: [] };
  const rows = (await (memberships ?? collectionMemberships(workspaceId))).filter((r) => inGraph.has(r.paperId));
  const byPaper = new Map<string, string[]>();
  const used = new Map<string, { id: string; name: string; color: string | null }>();
  for (const r of rows) {
    byPaper.set(r.paperId, [...(byPaper.get(r.paperId) ?? []), r.id]);
    used.set(r.id, { id: r.id, name: r.name, color: r.color });
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.type === "paper" ? { ...n, collectionIds: byPaper.get(n.entityId) ?? [] } : n)),
    collections: [...used.values()],
  };
}

export async function workspaceGraph(workspaceId: string, opts: GraphOptions = {}): Promise<GraphResponse> {
  const memberships = collectionMemberships(workspaceId);
  memberships.catch(() => {}); // awaited below; avoids an unhandled rejection if the graph fails first
  return withCollections(workspaceId, finalize(await loadWorkspaceGraph(workspaceId, opts)), memberships);
}

/** Neighborhood (up to `depth` hops) around one paper, concept or note. */
export async function focusedGraph(
  workspaceId: string,
  focus: { type: GraphNodeType; id: string },
  depth = 1,
  opts: GraphOptions = {},
): Promise<GraphResponse> {
  const g = await loadWorkspaceGraph(workspaceId, { ...opts, includeArchived: true, collectionId: undefined });
  const focusId = nid(focus.type, focus.id);

  if (!g.nodes.has(focusId) && focus.type === "paper") {
    // A paper outside the library: show it with whatever links reference it.
    const [p] = await db
      .select({ id: papers.id, title: papers.title, year: papers.year, authorsText: papers.authorsText })
      .from(papers)
      .where(
        and(eq(papers.id, focus.id), or(isNull(papers.ownerWorkspaceId), eq(papers.ownerWorkspaceId, workspaceId))),
      );
    if (p) {
      g.nodes.set(focusId, {
        id: focusId,
        type: "paper",
        entityId: p.id,
        label: p.title,
        sublabel: [shortAuthors(p.authorsText), p.year].filter(Boolean).join(", "),
        status: null,
        year: p.year,
      });
      const libIds = [...g.nodes.values()].filter((n) => n.type === "paper").map((n) => n.entityId);
      const cites = await db
        .select({ citing: citations.citingPaperId, cited: citations.citedPaperId })
        .from(citations)
        .where(
          or(
            and(eq(citations.citingPaperId, focus.id), inArray(citations.citedPaperId, libIds)),
            and(eq(citations.citedPaperId, focus.id), inArray(citations.citingPaperId, libIds)),
          ),
        );
      for (const c of cites) addEdge(g, "cites", nid("paper", c.citing), nid("paper", c.cited));
      const pc = await db
        .select({ conceptId: paperConcepts.conceptId })
        .from(paperConcepts)
        .innerJoin(concepts, eq(concepts.id, paperConcepts.conceptId))
        .where(and(eq(paperConcepts.paperId, focus.id), eq(concepts.workspaceId, workspaceId)));
      for (const r of pc) addEdge(g, "paper_concept", focusId, nid("concept", r.conceptId));
    }
  }
  if (!g.nodes.has(focusId)) return { nodes: [], edges: [], truncated: false };

  const adjacency = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (e.type === "cites" && opts.includeCitations === false) continue;
    if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
    if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
    adjacency.get(e.source)!.add(e.target);
    adjacency.get(e.target)!.add(e.source);
  }
  const keep = new Set([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacency.get(id) ?? []) {
        if (!keep.has(n)) {
          keep.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  const pruned = prune(g, keep);
  if (opts.includeCitations === false) pruned.edges = pruned.edges.filter((e) => e.type !== "cites");
  return withCollections(workspaceId, finalize(pruned, 300));
}
