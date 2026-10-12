/**
 * Where a paper may belong in a workspace, without AI: existing concepts named in its title or abstract,
 * and the collections and concepts of saved papers it cites or that cite it. The assistant uses these as
 * hints when it saves papers, and judges them by the abstract before proposing anything.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  citations,
  collectionPapers,
  collections,
  concepts,
  libraryItems,
  paperConcepts,
  papers,
} from "@/server/db/schema";

export interface PlacementHint {
  name: string;
  why: string;
}

export interface Placement {
  collections: PlacementHint[];
  concepts: PlacementHint[];
}

const MAX_COLLECTIONS = 3;
const MAX_CONCEPTS = 5;

/** Whether `name` appears in `text` as a whole word or phrase (plurals too; acronyms match case). */
export function namedIn(name: string, text: string) {
  const n = name.trim();
  if (n.length < 2) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  const acronym = n === n.toUpperCase() && /\p{L}/u.test(n);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:s|es)?(?![\\p{L}\\p{N}])`, acronym ? "u" : "iu").test(text);
}

export async function placementHints(workspaceId: string, paperIds: string[]): Promise<Map<string, Placement>> {
  const result = new Map<string, Placement>();
  if (!paperIds.length) return result;
  const saved = db
    .select({ id: libraryItems.paperId })
    .from(libraryItems)
    .where(eq(libraryItems.workspaceId, workspaceId));
  const [texts, conceptRows, edges, ownCollections, ownConcepts] = await Promise.all([
    db
      .select({ id: papers.id, title: papers.title, abstract: papers.abstract })
      .from(papers)
      .where(inArray(papers.id, paperIds)),
    db
      .select({ name: concepts.name, aliases: concepts.aliases })
      .from(concepts)
      .where(eq(concepts.workspaceId, workspaceId)),
    db
      .select({ citing: citations.citingPaperId, cited: citations.citedPaperId })
      .from(citations)
      .where(
        or(
          and(inArray(citations.citingPaperId, paperIds), inArray(citations.citedPaperId, saved)),
          and(inArray(citations.citedPaperId, paperIds), inArray(citations.citingPaperId, saved)),
        ),
      ),
    db
      .select({ paperId: collectionPapers.paperId, name: collections.name })
      .from(collectionPapers)
      .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
      .where(and(eq(collections.workspaceId, workspaceId), inArray(collectionPapers.paperId, paperIds))),
    db
      .select({ paperId: paperConcepts.paperId, name: concepts.name })
      .from(paperConcepts)
      .innerJoin(concepts, eq(concepts.id, paperConcepts.conceptId))
      .where(and(eq(concepts.workspaceId, workspaceId), inArray(paperConcepts.paperId, paperIds))),
  ]);

  // Citation neighbours already in the library, per paper.
  const neighbours = new Map<string, { cites: Set<string>; citedBy: Set<string> }>();
  const neighboursOf = (id: string) => {
    const n = neighbours.get(id) ?? { cites: new Set<string>(), citedBy: new Set<string>() };
    neighbours.set(id, n);
    return n;
  };
  for (const e of edges) {
    if (paperIds.includes(e.citing) && e.cited !== e.citing) neighboursOf(e.citing).cites.add(e.cited);
    if (paperIds.includes(e.cited) && e.cited !== e.citing) neighboursOf(e.cited).citedBy.add(e.citing);
  }
  const allNeighbours = [...new Set([...neighbours.values()].flatMap((n) => [...n.cites, ...n.citedBy]))];
  const [neighbourCollections, neighbourConcepts] = allNeighbours.length
    ? await Promise.all([
        db
          .select({ paperId: collectionPapers.paperId, name: collections.name })
          .from(collectionPapers)
          .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
          .where(and(eq(collections.workspaceId, workspaceId), inArray(collectionPapers.paperId, allNeighbours))),
        db
          .select({ paperId: paperConcepts.paperId, name: concepts.name })
          .from(paperConcepts)
          .innerJoin(concepts, eq(concepts.id, paperConcepts.conceptId))
          .where(and(eq(concepts.workspaceId, workspaceId), inArray(paperConcepts.paperId, allNeighbours))),
      ])
    : [[], []];

  /** "cites 2 of its papers; cited by 1" — how a paper connects to the members of a group. */
  const viaCitations = (members: Set<string>, n: { cites: Set<string>; citedBy: Set<string> }) => {
    const cites = [...n.cites].filter((id) => members.has(id)).length;
    const citedBy = [...n.citedBy].filter((id) => members.has(id)).length;
    return { score: cites + citedBy, cites, citedBy };
  };
  const membersByName = (rows: { paperId: string; name: string }[]) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) m.set(r.name, (m.get(r.name) ?? new Set()).add(r.paperId));
    return m;
  };
  const collectionMembers = membersByName(neighbourCollections);
  const conceptMembers = membersByName(neighbourConcepts);
  const citationWhy = (c: { cites: number; citedBy: number }) =>
    [
      c.cites ? `it cites ${c.cites} of its papers` : "",
      c.citedBy ? `${c.citedBy} of its papers cite${c.citedBy === 1 ? "s" : ""} it` : "",
    ]
      .filter(Boolean)
      .join("; ");

  for (const p of texts) {
    const has = (rows: { paperId: string; name: string }[]) =>
      new Set(rows.filter((r) => r.paperId === p.id).map((r) => r.name));
    const inCollections = has(ownCollections);
    const inConcepts = has(ownConcepts);
    const n = neighbours.get(p.id) ?? { cites: new Set<string>(), citedBy: new Set<string>() };
    const text = `${p.title}\n${p.abstract ?? ""}`;

    const collectionHints = [...collectionMembers.entries()]
      .filter(([name]) => !inCollections.has(name))
      .map(([name, members]) => ({ name, c: viaCitations(members, n) }))
      .filter((h) => h.c.score > 0)
      .sort((a, b) => b.c.score - a.c.score || a.name.localeCompare(b.name))
      .slice(0, MAX_COLLECTIONS)
      .map((h) => ({ name: h.name, why: citationWhy(h.c) }));

    const conceptHints = new Map<string, { score: number; why: string[] }>();
    for (const c of conceptRows) {
      if (inConcepts.has(c.name)) continue;
      const named = [c.name, ...(c.aliases ?? [])].find((alias) => namedIn(alias, text));
      if (named) {
        const where = namedIn(named, p.title) ? "title" : "abstract";
        conceptHints.set(c.name, {
          score: 2,
          why: [named === c.name ? `named in its ${where}` : `“${named}” in its ${where}`],
        });
      }
    }
    for (const [name, members] of conceptMembers) {
      if (inConcepts.has(name)) continue;
      const c = viaCitations(members, n);
      if (!c.score) continue;
      const hint = conceptHints.get(name) ?? { score: 0, why: [] };
      conceptHints.set(name, { score: hint.score + c.score, why: [...hint.why, citationWhy(c)] });
    }

    result.set(p.id, {
      collections: collectionHints,
      concepts: [...conceptHints.entries()]
        .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
        .slice(0, MAX_CONCEPTS)
        .map(([name, h]) => ({ name, why: h.why.join("; ") })),
    });
  }
  return result;
}
