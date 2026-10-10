/**
 * Data portability: full JSON export, Markdown (zip of notes, concepts and paper cards with
 * wiki-links, Obsidian-compatible) and BibTeX.
 */
import { and, eq, inArray } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { docToMarkdown, type PMNode } from "@/lib/prosemirror";
import { db } from "@/server/db/client";
import {
  citations,
  collectionPapers,
  collections,
  conceptRelations,
  concepts,
  highlights,
  libraryItems,
  noteLinks,
  notes,
  paperConcepts,
  papers,
  paperTags,
  tags,
} from "@/server/db/schema";
import { identifiersFor } from "@/server/papers/service";
import { toBibtex, type BibPaper } from "./bibtex";

export const EXPORT_FORMAT_VERSION = 1;

async function loadWorkspaceData(workspaceId: string) {
  const lib = await db
    .select({ paper: papers, status: libraryItems.status, addedAt: libraryItems.createdAt })
    .from(libraryItems)
    .innerJoin(papers, eq(papers.id, libraryItems.paperId))
    .where(eq(libraryItems.workspaceId, workspaceId))
    .orderBy(libraryItems.createdAt);
  const noteRows = await db.select().from(notes).where(eq(notes.workspaceId, workspaceId)).orderBy(notes.createdAt);
  // Papers referenced by notes are exported too, even if no longer in the library.
  const noteLinkRows = noteRows.length
    ? await db
        .select()
        .from(noteLinks)
        .where(
          inArray(
            noteLinks.noteId,
            noteRows.map((n) => n.id),
          ),
        )
    : [];
  const libIds = new Set(lib.map((l) => l.paper.id));
  const extraIds = [
    ...new Set(
      [...noteRows.map((n) => n.paperId), ...noteLinkRows.map((l) => l.targetPaperId)].filter(
        (id): id is string => !!id && !libIds.has(id),
      ),
    ),
  ];
  const extra = extraIds.length ? await db.select().from(papers).where(inArray(papers.id, extraIds)) : [];
  const allPapers = [...lib.map((l) => l.paper), ...extra];
  const ids = await identifiersFor(allPapers.map((p) => p.id));

  const [collectionRows, tagRows, conceptRows, highlightRows] = await Promise.all([
    db.select().from(collections).where(eq(collections.workspaceId, workspaceId)),
    db.select().from(tags).where(eq(tags.workspaceId, workspaceId)),
    db.select().from(concepts).where(eq(concepts.workspaceId, workspaceId)),
    db.select().from(highlights).where(eq(highlights.workspaceId, workspaceId)),
  ]);
  const [cp, pt, pc, cr, cites] = await Promise.all([
    collectionRows.length
      ? db
          .select()
          .from(collectionPapers)
          .where(
            inArray(
              collectionPapers.collectionId,
              collectionRows.map((c) => c.id),
            ),
          )
      : [],
    tagRows.length
      ? db
          .select()
          .from(paperTags)
          .where(
            inArray(
              paperTags.tagId,
              tagRows.map((t) => t.id),
            ),
          )
      : [],
    conceptRows.length
      ? db
          .select()
          .from(paperConcepts)
          .where(
            inArray(
              paperConcepts.conceptId,
              conceptRows.map((c) => c.id),
            ),
          )
      : [],
    conceptRows.length
      ? db
          .select()
          .from(conceptRelations)
          .where(
            inArray(
              conceptRelations.conceptAId,
              conceptRows.map((c) => c.id),
            ),
          )
      : [],
    libIds.size > 1
      ? db
          .select({ citing: citations.citingPaperId, cited: citations.citedPaperId, source: citations.source })
          .from(citations)
          .where(and(inArray(citations.citingPaperId, [...libIds]), inArray(citations.citedPaperId, [...libIds])))
      : [],
  ]);
  return {
    lib,
    extra,
    allPapers,
    ids,
    noteRows,
    noteLinkRows,
    collectionRows,
    tagRows,
    conceptRows,
    highlightRows,
    cp,
    pt,
    pc,
    cr,
    cites,
  };
}

export async function exportJson(workspaceId: string) {
  const d = await loadWorkspaceData(workspaceId);
  const status = new Map(d.lib.map((l) => [l.paper.id, { status: l.status, addedAt: l.addedAt.toISOString() }]));
  const tagName = new Map(d.tagRows.map((t) => [t.id, t.name]));
  return {
    format: "paperweave-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    papers: d.allPapers.map((p) => ({
      id: p.id,
      identifiers: d.ids.get(p.id) ?? {},
      title: p.title,
      authors: p.authors,
      year: p.year,
      publicationDate: p.publicationDate,
      venue: p.venue,
      abstract: p.abstract,
      publicationTypes: p.publicationTypes,
      citationCount: p.citationCount,
      openAccessPdfUrl: p.openAccessPdfUrl,
      url: p.url,
      metadataSource: p.source,
      userEntered: p.ownerWorkspaceId !== null,
      library: status.get(p.id) ?? null,
      tags: d.pt.filter((x) => x.paperId === p.id).map((x) => tagName.get(x.tagId)),
    })),
    collections: d.collectionRows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      color: c.color,
      paperIds: d.cp.filter((x) => x.collectionId === c.id).map((x) => x.paperId),
    })),
    tags: d.tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    concepts: d.conceptRows.map((c) => ({
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      description: c.description,
      origin: c.origin,
      paperIds: d.pc.filter((x) => x.conceptId === c.id).map((x) => x.paperId),
      relatedConceptIds: d.cr
        .filter((x) => x.conceptAId === c.id || x.conceptBId === c.id)
        .map((x) => (x.conceptAId === c.id ? x.conceptBId : x.conceptAId)),
    })),
    notes: d.noteRows.map((n) => ({
      id: n.id,
      title: n.title,
      paperId: n.paperId,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
      markdown: docToMarkdown(n.content as PMNode),
      content: n.content,
      links: d.noteLinkRows
        .filter((l) => l.noteId === n.id)
        .map((l) =>
          l.targetPaperId
            ? { type: "paper", id: l.targetPaperId }
            : l.targetConceptId
              ? { type: "concept", id: l.targetConceptId }
              : { type: "note", id: l.targetNoteId },
        ),
    })),
    highlights: d.highlightRows.map((h) => ({
      id: h.id,
      paperId: h.paperId,
      fileId: h.fileId,
      kind: h.kind,
      pageNumber: h.pageNumber,
      rects: h.rects,
      selectedText: h.selectedText,
      prefix: h.prefix,
      suffix: h.suffix,
      color: h.color,
      comment: h.comment,
      createdAt: h.createdAt.toISOString(),
    })),
    citations: d.cites.map((c) => ({ citingPaperId: c.citing, citedPaperId: c.cited, source: c.source })),
  };
}

function toBibPaper(p: typeof papers.$inferSelect, ids: Partial<Record<string, string>>): BibPaper {
  return {
    title: p.title,
    authors: p.authors.map((a) => a.name),
    year: p.year,
    venue: p.venue,
    publicationTypes: p.publicationTypes,
    abstract: p.abstract,
    url: p.url,
    ids,
  };
}

export async function exportBibtex(workspaceId: string, opts: { collectionId?: string; paperIds?: string[] } = {}) {
  let rows = await db
    .select({ paper: papers })
    .from(libraryItems)
    .innerJoin(papers, eq(papers.id, libraryItems.paperId))
    .where(eq(libraryItems.workspaceId, workspaceId))
    .orderBy(libraryItems.createdAt);
  if (opts.collectionId) {
    const members = new Set(
      (
        await db
          .select({ id: collectionPapers.paperId })
          .from(collectionPapers)
          .innerJoin(collections, eq(collections.id, collectionPapers.collectionId))
          .where(and(eq(collectionPapers.collectionId, opts.collectionId), eq(collections.workspaceId, workspaceId)))
      ).map((r) => r.id),
    );
    rows = rows.filter((r) => members.has(r.paper.id));
  }
  if (opts.paperIds) {
    const wanted = new Set(opts.paperIds);
    rows = rows.filter((r) => wanted.has(r.paper.id));
  }
  const ids = await identifiersFor(rows.map((r) => r.paper.id));
  return toBibtex(rows.map((r) => toBibPaper(r.paper, ids.get(r.paper.id) ?? {})));
}

function fileSafe(name: string) {
  return (
    name
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Untitled"
  );
}

function frontmatter(fields: Record<string, string | number | null | undefined | string[]>) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
    .map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}`,
    );
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/** Builds a zip of Markdown files with [[wiki-links]] between them. */
export async function exportMarkdownZip(workspaceId: string): Promise<Uint8Array> {
  const d = await loadWorkspaceData(workspaceId);
  const files: Record<string, Uint8Array> = {};
  const names = new Map<string, string>(); // "type:id" → file base name (unique across the vault)
  const taken = new Set<string>();
  const nameFor = (key: string, label: string) => {
    let base = fileSafe(label);
    let i = 2;
    while (taken.has(base.toLowerCase())) base = `${fileSafe(label)} (${i++})`;
    taken.add(base.toLowerCase());
    names.set(key, base);
    return base;
  };
  for (const c of d.conceptRows) nameFor(`concept:${c.id}`, c.name);
  for (const p of d.allPapers) nameFor(`paper:${p.id}`, p.title);
  for (const n of d.noteRows) nameFor(`note:${n.id}`, n.title || "Untitled note");
  const link = (key: string) => (names.has(key) ? `[[${names.get(key)}]]` : null);

  // Mentions are exported as [[label]]; rewrite labels to the unique file names.
  const relabel = (node: PMNode): PMNode => {
    if (node.type === "mention" && typeof node.attrs?.id === "string" && names.has(String(node.attrs.id))) {
      return { ...node, attrs: { ...node.attrs, label: names.get(String(node.attrs.id)) } };
    }
    return node.content ? { ...node, content: node.content.map(relabel) } : node;
  };

  const status = new Map(d.lib.map((l) => [l.paper.id, l.status]));
  const tagName = new Map(d.tagRows.map((t) => [t.id, t.name]));
  const collName = new Map(d.collectionRows.map((c) => [c.id, c.name]));

  for (const p of d.allPapers) {
    const ids = d.ids.get(p.id) ?? {};
    const related = d.pc.filter((x) => x.paperId === p.id).map((x) => link(`concept:${x.conceptId}`));
    const paperNotes = d.noteRows.filter((n) => n.paperId === p.id).map((n) => link(`note:${n.id}`));
    const body = [
      `# ${p.title}`,
      p.authors.length ? `**Authors:** ${p.authors.map((a) => a.name).join(", ")}` : "",
      [p.venue, p.year].filter(Boolean).join(", "),
      p.abstract ? `## Abstract\n\n${p.abstract}` : "",
      related.length
        ? `## Concepts\n\n${related
            .filter(Boolean)
            .map((l) => `- ${l}`)
            .join("\n")}`
        : "",
      paperNotes.length
        ? `## Notes\n\n${paperNotes
            .filter(Boolean)
            .map((l) => `- ${l}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    files[`papers/${names.get(`paper:${p.id}`)}.md`] = strToU8(
      frontmatter({
        type: "paper",
        id: p.id,
        doi: ids.doi,
        arxiv: ids.arxiv,
        semantic_scholar: ids.s2,
        openalex: ids.openalex,
        pmid: ids.pmid,
        year: p.year,
        status: status.get(p.id),
        tags: d.pt.filter((x) => x.paperId === p.id).map((x) => tagName.get(x.tagId) ?? ""),
        collections: d.cp.filter((x) => x.paperId === p.id).map((x) => collName.get(x.collectionId) ?? ""),
      }) +
        body +
        "\n",
    );
  }

  for (const c of d.conceptRows) {
    const linkedPapers = d.pc.filter((x) => x.conceptId === c.id).map((x) => link(`paper:${x.paperId}`));
    const related = d.cr
      .filter((x) => x.conceptAId === c.id || x.conceptBId === c.id)
      .map((x) => link(`concept:${x.conceptAId === c.id ? x.conceptBId : x.conceptAId}`));
    const body = [
      `# ${c.name}`,
      c.description,
      linkedPapers.length
        ? `## Papers\n\n${linkedPapers
            .filter(Boolean)
            .map((l) => `- ${l}`)
            .join("\n")}`
        : "",
      related.length
        ? `## Related concepts\n\n${related
            .filter(Boolean)
            .map((l) => `- ${l}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    files[`concepts/${names.get(`concept:${c.id}`)}.md`] = strToU8(
      frontmatter({ type: "concept", id: c.id, aliases: c.aliases }) + body + "\n",
    );
  }

  for (const n of d.noteRows) {
    const about = n.paperId ? link(`paper:${n.paperId}`) : null;
    const md = docToMarkdown(relabel(n.content as PMNode));
    files[`notes/${names.get(`note:${n.id}`)}.md`] = strToU8(
      frontmatter({
        type: "note",
        id: n.id,
        created: n.createdAt.toISOString(),
        updated: n.updatedAt.toISOString(),
      }) +
        `# ${n.title || "Untitled note"}\n\n` +
        (about ? `About: ${about}\n\n` : "") +
        md,
    );
  }

  files["library.bib"] = strToU8(toBibtex(d.lib.map((l) => toBibPaper(l.paper, d.ids.get(l.paper.id) ?? {}))));
  files["README.md"] = strToU8(
    `# Paperweave export\n\nExported ${new Date().toISOString()}.\n\n- \`papers/\` – one card per paper with identifiers in the front matter\n- \`concepts/\` – your concepts\n- \`notes/\` – your notes; links use [[wiki-link]] syntax and resolve to the files in this archive\n- \`library.bib\` – BibTeX for your library\n\nFor a complete, machine-readable export (including highlights and all relationships) use the JSON export.\n`,
  );
  return zipSync(files, { level: 6 });
}
