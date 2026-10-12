/**
 * Workspace changes proposed by the assistant: saving papers, collections, tags, concepts, notes and
 * open-access PDFs. The model only proposes; Paperweave validates each proposal against the workspace
 * (resolving citation keys to papers, turning "create" into "add to" when something already exists),
 * and applies them when the user approves — or right away with auto-apply. Every applied change
 * records what it did, so it can be undone precisely.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { conceptKey } from "@/lib/concept-names";
import { markdownToDoc } from "@/lib/markdown-doc";
import { parseMentionId, walk, type PMNode } from "@/lib/prosemirror";
import {
  READING_STATUSES,
  SOURCE_PRIORITIES,
  type ProposedChange,
  type ReadingStatus,
  type ResearchSource,
  type SourcePriority,
} from "@/lib/types";
import { db } from "@/server/db/client";
import {
  collectionPapers,
  collections,
  conceptRelations,
  concepts,
  libraryItems,
  noteLinks,
  notes,
  paperConcepts,
  paperFiles,
  paperTags,
  savedSearches,
  tags,
} from "@/server/db/schema";
import { createSavedSearch, deleteSavedSearch } from "@/server/alerts/service";
import { createScreening, deleteScreening } from "@/server/screening/service";
import { anchorHighlight, readPdfContents } from "@/server/files/anchor";
import { createHighlight, deleteHighlight } from "@/server/files/highlights";
import { attachPdfFromUrl, deleteFile, fileBytes, openAccessCandidates } from "@/server/files/service";
import { AppError, type RequestContext } from "@/server/http";
import {
  createConcept,
  deleteConcept,
  linkPaper,
  relateConcepts,
  unlinkPaper,
  updateConcept,
} from "@/server/knowledge/concepts";
import { createNote, deleteNote, loadNote, updateNote } from "@/server/knowledge/notes";
import { removeFromLibrary, savePaper, setStatus } from "@/server/library/library";
import {
  addToCollection,
  collectionPaperIds,
  createCollection,
  deleteCollection,
  deleteTag,
  removeFromCollection,
  tagPapers,
  updateCollection,
  updateTag,
} from "@/server/library/organize";
import {
  restoreSnapshot,
  snapshotCollection,
  snapshotConcept,
  snapshotLibrary,
  snapshotSavedSearch,
  snapshotTag,
} from "./removal";
import { applyBlockEdits, planBlockEdits, type PlannedEdit } from "./note-blocks";
import type { SourceRegistry } from "./tools";
import { placementLines } from "./workspace-tools";

// ---------------------------------------------------------------------------
// Protocol (what the model may propose)
// ---------------------------------------------------------------------------

const key = z
  .string()
  .trim()
  .regex(/^[PNpn]\d{1,4}$/);
const papers = z.array(key).min(1).max(50);
const name = z.string().trim().min(1).max(120);

/** The model's view of how useful a concept is for connecting the library, and why. */
const conceptRanking = {
  priority: z
    .string()
    .transform((v) => SOURCE_PRIORITIES.find((p) => p === v.trim().toLowerCase()))
    .optional()
    .catch(undefined),
  why: z
    .string()
    .trim()
    .max(300)
    .transform((v) => v || undefined)
    .optional()
    .catch(undefined),
};

export const changeActionSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("save_papers"),
    papers,
    status: z.enum(READING_STATUSES).optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("create_collection"),
    name,
    description: z.string().trim().max(500).optional(),
    papers: z.array(key).max(50).default([]),
  }),
  z.object({ tool: z.literal("add_to_collection"), collection: name, papers }),
  z.object({ tool: z.literal("tag_papers"), tags: z.array(name).min(1).max(10), papers }),
  z.object({
    tool: z.literal("create_concept"),
    name,
    description: z.string().trim().max(500).optional(),
    papers: z.array(key).max(80).default([]),
    /** Broader concepts this one belongs under (existing, or proposed in the same set). */
    related: z.array(name).max(5).default([]),
    ...conceptRanking,
  }),
  z.object({
    tool: z.literal("link_concept"),
    concept: name,
    // Library-wide concepts can link many papers.
    papers: z.array(key).min(1).max(80),
    related: z.array(name).max(5).default([]),
    ...conceptRanking,
  }),
  z.object({
    tool: z.literal("create_note"),
    title: z.string().trim().min(1).max(300),
    content: z.string().min(1).max(40_000),
    paper: key.optional(),
  }),
  z.object({ tool: z.literal("attach_pdfs"), papers }),
  z.object({ tool: z.literal("set_reading_status"), papers, status: z.enum(READING_STATUSES) }),
  z.object({ tool: z.literal("remove_from_collection"), collection: name, papers }),
  z.object({ tool: z.literal("unlink_concept"), concept: name, papers }),
  z.object({ tool: z.literal("relate_concepts"), concept: name, related: z.array(name).min(1).max(5) }),
  z.object({ tool: z.literal("append_to_note"), note: key, content: z.string().min(1).max(20_000) }),
  z.object({
    tool: z.literal("link_note"),
    note: key,
    paper: key.optional(),
    links: z.array(key).max(20).default([]),
  }),
  z.object({ tool: z.literal("merge_concepts"), into: name, from: z.array(name).min(1).max(10) }),
  z.object({ tool: z.literal("rename_concept"), concept: name, name }),
  z.object({
    tool: z.literal("start_screening"),
    title: z.string().trim().min(1).max(200),
    criteria: z.string().trim().min(10).max(8000),
    papers: z.array(key).max(500).default([]),
    collection: name.optional(),
    use_full_text: z.boolean().optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("save_search"),
    query: z.string().trim().min(2).max(300),
    source: z.enum(["general", "biomedical", "openreview", "arxiv"]).default("general"),
  }),
  z.object({
    tool: z.literal("add_highlight"),
    paper: key,
    text: z.string().trim().min(3).max(2000),
    page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
    comment: z.string().trim().max(2000).optional(),
    color: z.enum(["yellow", "green", "blue", "pink", "purple"]).optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("edit_note"),
    note: key,
    edits: z
      .array(
        z.object({
          op: z.enum(["replace", "delete", "insert"]),
          block: z.coerce.number().int().min(0).max(10_000),
          content: z.string().max(20_000).optional(),
        }),
      )
      .min(1)
      .max(40),
  }),
  z.object({
    tool: z.literal("edit_collection"),
    collection: name,
    name: name.optional(),
    description: z.string().trim().max(500).optional(),
  }),
  z.object({ tool: z.literal("delete_collection"), collection: name }),
  z.object({ tool: z.literal("untag_papers"), tags: z.array(name).min(1).max(10), papers }),
  z.object({ tool: z.literal("rename_tag"), tag: name, name }),
  z.object({ tool: z.literal("delete_tag"), tag: name }),
  z.object({ tool: z.literal("edit_concept"), concept: name, description: z.string().trim().min(1).max(500) }),
  z.object({ tool: z.literal("delete_concept"), concept: name }),
  z.object({ tool: z.literal("remove_from_library"), papers }),
  z.object({ tool: z.literal("stop_following"), query: z.string().trim().min(2).max(300) }),
]);
export type ChangeAction = z.infer<typeof changeActionSchema>;

export const CHANGE_TOOLS = new Set<string>(changeActionSchema.options.map((o) => o.shape.tool.value));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Where papers being saved may belong (existing collections and concepts, found without AI). Placing them is
 * the next step: the reply offers it, and the planner does it once the user agrees.
 */
async function placementNote(workspaceId: string, paperIds: string[], sources: SourceRegistry) {
  const keyOf = new Map(sources.all().map((s) => [s.id, s.key]));
  const items = paperIds.flatMap((id) => (keyOf.has(id) ? [{ key: keyOf.get(id)!, id }] : []));
  const lines = await placementLines(workspaceId, items);
  if (!lines.length) return "";
  return `\nPlacement not proposed yet. Where they may belong — hints from concept names and citations:\n${lines.join("\n")}\nUnless the user already asked for collections or concepts, do not propose them now: the reply asks whether to add the papers to collections and concepts.`;
}

async function inLibrary(workspaceId: string, paperIds: string[]): Promise<Set<string>> {
  if (!paperIds.length) return new Set();
  const rows = await db
    .select({ id: libraryItems.paperId })
    .from(libraryItems)
    .where(and(eq(libraryItems.workspaceId, workspaceId), inArray(libraryItems.paperId, paperIds)));
  return new Set(rows.map((r) => r.id));
}

async function collectionByName(workspaceId: string, n: string) {
  const [row] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.workspaceId, workspaceId), sql`lower(${collections.name}) = ${n.toLowerCase()}`));
  return row ?? null;
}

async function tagByName(workspaceId: string, n: string) {
  const wanted = n.replace(/^#/, "").trim().toLowerCase();
  const [row] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), sql`lower(${tags.name}) = ${wanted}`));
  return row ?? null;
}

async function tagPaperIds(tagId: string) {
  const rows = await db.select({ id: paperTags.paperId }).from(paperTags).where(eq(paperTags.tagId, tagId));
  return rows.map((r) => r.id);
}

async function savedSearchByQuery(workspaceId: string, query: string) {
  const [row] = await db
    .select()
    .from(savedSearches)
    .where(
      and(
        eq(savedSearches.workspaceId, workspaceId),
        sql`lower(${savedSearches.query}) = ${query.trim().replace(/\s+/g, " ").toLowerCase()}`,
      ),
    );
  return row ?? null;
}

const STATUS_WORD: Record<ReadingStatus, string> = {
  saved: "saved (to read)",
  reading: "reading",
  read: "read",
  archived: "archived",
};

async function conceptPaperIds(conceptId: string) {
  const rows = await db
    .select({ id: paperConcepts.paperId })
    .from(paperConcepts)
    .where(eq(paperConcepts.conceptId, conceptId));
  return rows.map((r) => r.id);
}

/** Names without case-insensitive duplicates, in order. */
function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/**
 * The workspace's concept with this name or one that means the same (plural, punctuation, an
 * abbreviation, or one of its aliases), so near-duplicates become links to the existing concept.
 */
async function conceptByName(workspaceId: string, n: string) {
  const wanted = conceptKey(n);
  const rows = await db
    .select({ id: concepts.id, name: concepts.name, aliases: concepts.aliases })
    .from(concepts)
    .where(eq(concepts.workspaceId, workspaceId));
  const exact = rows.find((c) => c.name.toLowerCase() === n.toLowerCase());
  return exact ?? rows.find((c) => [c.name, ...c.aliases].some((a) => conceptKey(a) === wanted)) ?? null;
}

function resolvePapers(sources: SourceRegistry, keys: string[]) {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const k of keys) {
    const s = sources.get(k);
    if (s?.type === "paper") {
      if (!ids.includes(s.id)) ids.push(s.id);
    } else unknown.push(k);
  }
  return { ids, unknown };
}

/** About 32 characters on each side of a quote in its page's text (the highlight's text-quote anchor). */
function quoteAround(pageText: string, quote: string) {
  const text = pageText.replace(/\s+/g, " ");
  const q = quote.replace(/\s+/g, " ").trim();
  const i = text.indexOf(q);
  if (i < 0) return { prefix: "", suffix: "" };
  return { prefix: text.slice(Math.max(0, i - 32), i), suffix: text.slice(i + q.length, i + q.length + 32) };
}

function errorText(err: unknown) {
  if (err instanceof AppError) return err.message;
  console.error("[assistant] change failed", err);
  return "Something went wrong while applying this change.";
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

export interface ProposalResult {
  /** The new or updated proposal; undefined when nothing needs to change. */
  change?: ProposedChange;
  /** What the model is told in the next round. */
  message: string;
}

/**
 * Validates one proposed action against the workspace and merges it into `existing` proposals of the
 * same kind and name (so a concept proposed twice becomes one change with all its papers).
 */
export async function proposeChange(
  workspaceId: string,
  action: ChangeAction,
  sources: SourceRegistry,
  existing: ProposedChange[],
): Promise<ProposalResult> {
  const keys = "papers" in action ? action.papers : action.tool === "create_note" && action.paper ? [action.paper] : [];
  const { ids, unknown } = resolvePapers(sources, keys);
  const unknownNote = unknown.length ? ` (ignored unknown keys: ${unknown.join(", ")})` : "";
  if (keys.length && !ids.length && action.tool !== "create_note") {
    return { message: `Not proposed: ${unknown.join(", ")} are not known paper keys.` };
  }

  const merge = (
    kind: ProposedChange["kind"],
    n: string | undefined,
    build: (paperIds: string[]) => ProposedChange,
  ) => {
    // Concepts proposed twice under near-identical names ("Point clouds", "point cloud") merge too.
    const sameName = (a: string, b: string) =>
      kind === "create_concept" || kind === "link_concept"
        ? conceptKey(a) === conceptKey(b)
        : a.toLowerCase() === b.toLowerCase();
    const same = existing.find((c) => c.kind === kind && c.status === "proposed" && sameName(c.name ?? "", n ?? ""));
    const paperIds = [...new Set([...(same?.paperIds ?? []), ...ids])];
    const built = build(paperIds);
    const related = uniqueNames([...(same?.related ?? []), ...(built.related ?? [])]).filter(
      (r) => r.toLowerCase() !== (n ?? "").toLowerCase(),
    );
    const priority = [same?.priority, built.priority]
      .filter((p): p is SourcePriority => !!p)
      .sort((a, b) => SOURCE_PRIORITIES.indexOf(a) - SOURCE_PRIORITIES.indexOf(b))[0];
    const change = {
      ...built,
      ...(priority ? { priority } : {}),
      ...(built.why || same?.why ? { why: built.why ?? same?.why } : {}),
      ...(related.length
        ? { related, label: `${built.label} · related to ${related.map((r) => `“${r}”`).join(", ")}` }
        : {}),
      id: same?.id ?? randomUUID(),
    };
    return { change, message: `Proposed change: ${change.label}${unknownNote}.` };
  };

  switch (action.tool) {
    case "save_papers": {
      const saved = await inLibrary(workspaceId, ids);
      const fresh = ids.filter((id) => !saved.has(id));
      if (!fresh.length) {
        return {
          message: `Not proposed: those papers are already in the library.${await placementNote(workspaceId, ids, sources)}`,
        };
      }
      const status = action.status ?? "saved";
      const same = existing.find((c) => c.kind === "save_papers" && c.status === "proposed");
      const paperIds = [...new Set([...(same?.paperIds ?? []), ...fresh])];
      const change: ProposedChange = {
        id: same?.id ?? randomUUID(),
        kind: "save_papers",
        label: `Save ${plural(paperIds.length, "paper")} to your library${status !== "saved" ? ` as “${status}”` : ""}`,
        paperIds,
        name: status,
        status: "proposed",
      };
      return {
        change,
        message: `Proposed change: ${change.label}${unknownNote}.${await placementNote(workspaceId, fresh, sources)}`,
      };
    }
    case "create_collection":
    case "add_to_collection": {
      const wanted = action.tool === "create_collection" ? action.name : action.collection;
      const found = await collectionByName(workspaceId, wanted);
      if (found && !ids.length) return { message: `Not proposed: the collection “${found.name}” already exists.` };
      if (found) {
        return merge("add_to_collection", found.name, (paperIds) => ({
          id: "",
          kind: "add_to_collection",
          label: `Add ${plural(paperIds.length, "paper")} to your collection “${found.name}”`,
          paperIds,
          name: found.name,
          status: "proposed",
        }));
      }
      return merge("create_collection", wanted, (paperIds) => ({
        id: "",
        kind: "create_collection",
        label: `Create collection “${wanted}”${paperIds.length ? ` with ${plural(paperIds.length, "paper")}` : ""}`,
        paperIds,
        name: wanted,
        description: action.tool === "create_collection" ? action.description : undefined,
        status: "proposed",
      }));
    }
    case "tag_papers": {
      const names = [...new Set(action.tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))];
      return merge("tag_papers", names.join(",").toLowerCase(), (paperIds) => ({
        id: "",
        kind: "tag_papers",
        label: `Tag ${plural(paperIds.length, "paper")} with ${names.map((t) => `#${t}`).join(", ")}`,
        paperIds,
        name: names.join(",").toLowerCase(),
        tags: names,
        status: "proposed",
      }));
    }
    case "create_concept":
    case "link_concept": {
      const wanted = action.tool === "create_concept" ? action.name : action.concept;
      const found = await conceptByName(workspaceId, wanted);
      if (found && !ids.length) return { message: `Not proposed: the concept “${found.name}” already exists.` };
      if (found) {
        return merge("link_concept", found.name, (paperIds) => ({
          id: "",
          kind: "link_concept",
          label: `Link your concept “${found.name}” to ${plural(paperIds.length, "paper")}${
            found.name.toLowerCase() !== wanted.toLowerCase() ? ` (suggested as “${wanted}”)` : ""
          }`,
          paperIds,
          name: found.name,
          related: action.related,
          priority: action.priority,
          why: action.why,
          status: "proposed",
        }));
      }
      if (action.tool === "link_concept" && !ids.length) return { message: "Not proposed: no papers to link." };
      return merge("create_concept", wanted, (paperIds) => ({
        id: "",
        kind: "create_concept",
        label: `Create concept “${wanted}”${paperIds.length ? ` and link it to ${plural(paperIds.length, "paper")}` : ""}`,
        paperIds,
        name: wanted,
        description: action.tool === "create_concept" ? action.description : undefined,
        related: action.related,
        priority: action.priority,
        why: action.why,
        status: "proposed",
      }));
    }
    case "create_note": {
      const doc = markdownToDoc(action.content, (k) => {
        const s = sources.get(k);
        if (!s) return undefined;
        return { type: s.type, id: s.id, label: s.title.length > 80 ? `${s.title.slice(0, 77)}…` : s.title };
      });
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "create_note",
        label: `Write a note “${action.title}”`,
        paperIds: ids.slice(0, 1),
        name: action.title,
        doc,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "set_reading_status": {
      const saved = await inLibrary(workspaceId, ids);
      const inLib = ids.filter((id) => saved.has(id));
      if (!inLib.length) return { message: "Not proposed: none of these papers are saved (save them instead)." };
      const label = STATUS_WORD[action.status];
      return merge("set_status", action.status, (paperIds) => ({
        id: "",
        kind: "set_status",
        label: `Mark ${plural(paperIds.length, "paper")} as ${label}`,
        paperIds,
        name: action.status,
        status: "proposed",
      }));
    }
    case "remove_from_collection": {
      const found = await collectionByName(workspaceId, action.collection);
      if (!found) return { message: `Not proposed: there is no collection “${action.collection}”.` };
      const members = new Set(await collectionPaperIds(found.id));
      const inside = ids.filter((id) => members.has(id));
      if (!inside.length) return { message: `Not proposed: none of these papers are in “${found.name}”.` };
      return merge("remove_from_collection", found.name, (paperIds) => {
        const kept = paperIds.filter((id) => members.has(id));
        return {
          id: "",
          kind: "remove_from_collection",
          label: `Remove ${plural(kept.length, "paper")} from your collection “${found.name}”`,
          paperIds: kept,
          name: found.name,
          status: "proposed",
        };
      });
    }
    case "unlink_concept": {
      const found = await conceptByName(workspaceId, action.concept);
      if (!found) return { message: `Not proposed: there is no concept “${action.concept}”.` };
      const linked = new Set(await conceptPaperIds(found.id));
      const inside = ids.filter((id) => linked.has(id));
      if (!inside.length) return { message: `Not proposed: none of these papers are linked to “${found.name}”.` };
      return merge("unlink_concept", found.name, (paperIds) => {
        const kept = paperIds.filter((id) => linked.has(id));
        return {
          id: "",
          kind: "unlink_concept",
          label: `Unlink ${plural(kept.length, "paper")} from your concept “${found.name}”`,
          paperIds: kept,
          name: found.name,
          status: "proposed",
        };
      });
    }
    case "relate_concepts": {
      const found = await conceptByName(workspaceId, action.concept);
      // The concept may also be one proposed earlier in this answer.
      const proposedHere = existing.some(
        (c) => c.kind === "create_concept" && conceptKey(c.name ?? "") === conceptKey(action.concept),
      );
      if (!found && !proposedHere) return { message: `Not proposed: there is no concept “${action.concept}”.` };
      const conceptName = found?.name ?? action.concept;
      return merge("relate_concepts", conceptName, () => ({
        id: "",
        kind: "relate_concepts",
        label: `Connect your concept “${conceptName}”`,
        paperIds: [],
        name: conceptName,
        related: action.related,
        status: "proposed",
      }));
    }
    case "append_to_note": {
      const source = sources.get(action.note);
      if (!source || source.type !== "note")
        return { message: `Not proposed: ${action.note} is not a known note key.` };
      const note = await loadNote(source.id).catch(() => null);
      if (!note || note.workspaceId !== workspaceId)
        return { message: "Not proposed: that note is not yours to edit." };
      const doc = markdownToDoc(action.content, (k) => {
        const s = sources.get(k);
        if (!s) return undefined;
        return { type: s.type, id: s.id, label: s.title.length > 80 ? `${s.title.slice(0, 77)}…` : s.title };
      });
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "append_to_note",
        label: `Add to your note “${note.title}”`,
        paperIds: [],
        name: note.title,
        noteId: note.id,
        doc,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "link_note": {
      const source = sources.get(action.note);
      if (!source || source.type !== "note")
        return { message: `Not proposed: ${action.note} is not a known note key.` };
      const note = await loadNote(source.id).catch(() => null);
      if (!note || note.workspaceId !== workspaceId)
        return { message: "Not proposed: that note is not yours to edit." };
      const paperSource = (k: string) => {
        const s = sources.get(k);
        return s?.type === "paper" ? s : null;
      };
      const attach = action.paper ? paperSource(action.paper) : null;
      if (action.paper && !attach) return { message: `Not proposed: ${action.paper} is not a known paper key.` };
      const already = new Set(
        (await db.select({ id: noteLinks.targetPaperId }).from(noteLinks).where(eq(noteLinks.noteId, note.id))).map(
          (r) => r.id,
        ),
      );
      const linked = [
        ...new Map(
          action.links
            .map(paperSource)
            .filter((s): s is ResearchSource => !!s && !already.has(s.id) && s.id !== attach?.id)
            .map((s) => [s.id, s]),
        ).values(),
      ];
      const attachChanges = !!attach && attach.id !== note.paperId;
      if (!attachChanges && !linked.length) {
        return { message: "Not proposed: the note is already attached to that paper and links those papers." };
      }
      const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);
      // Links are mentions in the note's text, so they are added as a short list at its end.
      const doc: PMNode | undefined = linked.length
        ? {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Related papers:" }] },
              {
                type: "bulletList",
                content: linked.map((s) => ({
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "mention", attrs: { id: `paper:${s.id}`, label: short(s.title) } }],
                    },
                  ],
                })),
              },
            ],
          }
        : undefined;
      const more = linked.length ? `${plural(linked.length, "paper")}` : "";
      const label = attachChanges
        ? `Attach your note “${note.title}” to “${short(attach!.title)}”${more ? ` and link it to ${more}` : ""}`
        : `Link your note “${note.title}” to ${more}`;
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "link_note",
        label,
        paperIds: [...(attachChanges ? [attach!.id] : []), ...linked.map((s) => s.id)],
        name: note.title,
        noteId: note.id,
        ...(attachChanges ? { attachPaperId: attach!.id } : {}),
        ...(doc ? { doc } : {}),
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "merge_concepts": {
      const into = await conceptByName(workspaceId, action.into);
      if (!into) return { message: `Not proposed: there is no concept “${action.into}” to merge into.` };
      const from: string[] = [];
      for (const n of action.from) {
        const found = await conceptByName(workspaceId, n);
        if (!found) return { message: `Not proposed: there is no concept “${n}”.` };
        if (found.id !== into.id && !from.includes(found.name)) from.push(found.name);
      }
      if (!from.length) return { message: "Not proposed: nothing to merge (those are the same concept)." };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "merge_concepts",
        label: `Merge your ${plural(from.length, "concept")} ${from.map((n) => `“${n}”`).join(", ")} into “${into.name}”`,
        paperIds: [],
        name: into.name,
        fromNames: from,
        status: "proposed",
      };
      return {
        change,
        message: `Proposed change: ${change.label} (their papers, notes and related concepts move to “${into.name}”; their names become aliases).`,
      };
    }
    case "rename_concept": {
      const found = await conceptByName(workspaceId, action.concept);
      if (!found) return { message: `Not proposed: there is no concept “${action.concept}”.` };
      const taken = await conceptByName(workspaceId, action.name);
      if (taken && taken.id !== found.id) {
        return { message: `Not proposed: “${taken.name}” already exists — merge_concepts instead.` };
      }
      if (found.name === action.name.trim()) return { message: `Not proposed: it is already called “${found.name}”.` };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "rename_concept",
        label: `Rename your concept “${found.name}” to “${action.name.trim()}”`,
        paperIds: [],
        name: action.name.trim(),
        fromNames: [found.name],
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label} (the old name stays as an alias).` };
    }
    case "edit_note": {
      const source = sources.get(action.note);
      if (!source || source.type !== "note")
        return { message: `Not proposed: ${action.note} is not a known note key.` };
      const note = await loadNote(source.id).catch(() => null);
      if (!note || note.workspaceId !== workspaceId)
        return { message: "Not proposed: that note is not yours to edit." };
      const plan = planBlockEdits(note.content as PMNode, action.edits, (k) => {
        const s = sources.get(k);
        if (!s) return undefined;
        return { type: s.type, id: s.id, label: s.title.length > 80 ? `${s.title.slice(0, 77)}…` : s.title };
      });
      if ("error" in plan) return { message: `Not proposed: ${plan.error} Read the note again (read_note).` };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "edit_note",
        label: `Edit your note “${note.title || "Untitled note"}” (${plural(plan.edits.length, "change")})`,
        paperIds: [],
        name: note.title,
        noteId: note.id,
        edits: plan.edits,
        doc: plan.planned,
        noteUpdatedAt: note.updatedAt.toISOString(),
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "start_screening": {
      const fromCollection = action.collection ? await collectionByName(workspaceId, action.collection) : null;
      if (action.collection && !fromCollection) {
        return { message: `Not proposed: there is no collection “${action.collection}”.` };
      }
      const paperIds = [...new Set([...ids, ...(fromCollection ? await collectionPaperIds(fromCollection.id) : [])])];
      if (!paperIds.length) return { message: "Not proposed: no papers to screen (give paper keys or a collection)." };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "start_screening",
        label: `Screen ${plural(paperIds.length, "paper")}${fromCollection ? ` in “${fromCollection.name}”` : ""} against your criteria (“${action.title}”)`,
        paperIds,
        name: action.title,
        description: action.criteria,
        ...(action.use_full_text ? { fromNames: ["full_text"] } : {}),
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}. It runs in the background once applied.` };
    }
    case "save_search": {
      const label = {
        general: "",
        biomedical: " in the biomedical literature",
        openreview: " on OpenReview",
        arxiv: " on arXiv",
      }[action.source];
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "save_search",
        label: `Follow “${action.query}”${label}: check daily and list new papers under New papers`,
        paperIds: [],
        name: action.query,
        description: action.source,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "edit_collection": {
      const found = await collectionByName(workspaceId, action.collection);
      if (!found) return { message: `Not proposed: there is no collection “${action.collection}”.` };
      const newName = action.name?.trim();
      const renaming = !!newName && newName !== found.name;
      if (renaming) {
        const taken = await collectionByName(workspaceId, newName);
        if (taken && taken.id !== found.id) return { message: `Not proposed: “${taken.name}” already exists.` };
      }
      const describing = action.description !== undefined && action.description !== found.description;
      if (!renaming && !describing) return { message: "Not proposed: nothing would change." };
      const what = [renaming && `rename it to “${newName}”`, describing && "update its description"]
        .filter(Boolean)
        .join(" and ");
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "edit_collection",
        label: `Your collection “${found.name}”: ${what}`,
        paperIds: [],
        name: renaming ? newName : found.name,
        fromNames: [found.name],
        ...(describing ? { description: action.description } : {}),
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "delete_collection": {
      const found = await collectionByName(workspaceId, action.collection);
      if (!found) return { message: `Not proposed: there is no collection “${action.collection}”.` };
      const count = (await collectionPaperIds(found.id)).length;
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "delete_collection",
        label: `Delete your collection “${found.name}” (its ${plural(count, "paper")} stay in your library)`,
        paperIds: [],
        name: found.name,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}. Ask before deleting unless the user asked for it.` };
    }
    case "untag_papers": {
      const found = (await Promise.all(action.tags.map((t) => tagByName(workspaceId, t)))).filter(
        (t): t is NonNullable<typeof t> => !!t,
      );
      if (!found.length)
        return { message: `Not proposed: there is no tag ${action.tags.map((t) => `#${t}`).join(", ")}.` };
      const tagged = new Set((await Promise.all(found.map((t) => tagPaperIds(t.id)))).flat());
      const inside = ids.filter((id) => tagged.has(id));
      if (!inside.length) return { message: "Not proposed: none of these papers have those tags." };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "untag_papers",
        label: `Remove ${found.map((t) => `#${t.name}`).join(", ")} from ${plural(inside.length, "paper")}`,
        paperIds: inside,
        tags: found.map((t) => t.name),
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}${unknownNote}.` };
    }
    case "rename_tag": {
      const found = await tagByName(workspaceId, action.tag);
      if (!found) return { message: `Not proposed: there is no tag #${action.tag.replace(/^#/, "")}.` };
      const newName = action.name.replace(/^#/, "").trim();
      const taken = await tagByName(workspaceId, newName);
      if (taken && taken.id !== found.id) {
        return {
          message: `Not proposed: #${taken.name} already exists — untag_papers and tag_papers to combine them.`,
        };
      }
      if (found.name === newName) return { message: `Not proposed: it is already called #${found.name}.` };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "rename_tag",
        label: `Rename tag #${found.name} to #${newName}`,
        paperIds: [],
        name: newName,
        fromNames: [found.name],
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "delete_tag": {
      const found = await tagByName(workspaceId, action.tag);
      if (!found) return { message: `Not proposed: there is no tag #${action.tag.replace(/^#/, "")}.` };
      const count = (await tagPaperIds(found.id)).length;
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "delete_tag",
        label: `Delete tag #${found.name}${count ? ` (removes it from ${plural(count, "paper")})` : ""}`,
        paperIds: [],
        name: found.name,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "edit_concept": {
      const found = await conceptByName(workspaceId, action.concept);
      if (!found) return { message: `Not proposed: there is no concept “${action.concept}”.` };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "edit_concept",
        label: `Update the description of your concept “${found.name}”`,
        paperIds: [],
        name: found.name,
        description: action.description,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "delete_concept": {
      const found = await conceptByName(workspaceId, action.concept);
      if (!found) return { message: `Not proposed: there is no concept “${action.concept}”.` };
      const count = (await conceptPaperIds(found.id)).length;
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "delete_concept",
        label: `Delete your concept “${found.name}”${count ? ` (unlinks ${plural(count, "paper")})` : ""}`,
        paperIds: [],
        name: found.name,
        status: "proposed",
      };
      return {
        change,
        message: `Proposed change: ${change.label}. Mentions of it in notes stop being links. To combine it with another concept, merge_concepts instead.`,
      };
    }
    case "remove_from_library": {
      const saved = await inLibrary(workspaceId, ids);
      const inLib = ids.filter((id) => saved.has(id));
      if (!inLib.length) return { message: "Not proposed: none of these papers are in the library." };
      return merge("remove_from_library", "library", (paperIds) => ({
        id: "",
        kind: "remove_from_library",
        label: `Remove ${plural(paperIds.length, "paper")} from your library (their notes, highlights and PDFs are kept)`,
        paperIds,
        name: "library",
        status: "proposed",
      }));
    }
    case "stop_following": {
      const found = await savedSearchByQuery(workspaceId, action.query);
      if (!found)
        return {
          message: `Not proposed: you are not following “${action.query}” (read_new_papers lists what you follow).`,
        };
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "stop_following",
        label: `Stop following “${found.query}” (New papers stops checking it)`,
        paperIds: [],
        name: found.query,
        description: found.source,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
    case "add_highlight": {
      const source = sources.get(action.paper);
      if (!source || source.type !== "paper")
        return { message: `Not proposed: ${action.paper} is not a known paper key.` };
      const [file] = await db
        .select()
        .from(paperFiles)
        .where(and(eq(paperFiles.workspaceId, workspaceId), eq(paperFiles.paperId, source.id)))
        .orderBy(desc(paperFiles.createdAt))
        .limit(1);
      if (!file) {
        return {
          message: `Not proposed: ${action.paper} has no PDF here yet — propose attach_pdfs first, then highlight.`,
        };
      }
      const { layouts } = await readPdfContents(await fileBytes(file));
      const placed = anchorHighlight(layouts, {
        kind: "highlight",
        pageNumber: action.page ?? 1,
        rects: [],
        selectedText: action.text,
        prefix: "",
        suffix: "",
      });
      if (!placed) {
        return {
          message: `Not proposed: that text was not found in the PDF of ${action.paper}. Quote it exactly as written (read_paper or find_passages first).`,
        };
      }
      const pageText = layouts[placed.pageNumber - 1].map((i) => i.str).join("");
      const short = action.text.length > 70 ? `${action.text.slice(0, 67)}…` : action.text;
      const change: ProposedChange = {
        id: randomUUID(),
        kind: "add_highlight",
        label: `Highlight “${short}” on p. ${placed.pageNumber}${action.comment ? " with a comment" : ""}`,
        paperIds: [source.id],
        description: action.comment,
        highlight: {
          fileId: file.id,
          pageNumber: placed.pageNumber,
          rects: placed.rects,
          selectedText: action.text,
          ...quoteAround(pageText, action.text),
          color: action.color ?? "yellow",
          comment: action.comment ?? "",
        },
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label} of ${action.paper}.` };
    }
    case "attach_pdfs": {
      const withFile = new Set(
        (
          await db
            .select({ id: paperFiles.paperId })
            .from(paperFiles)
            .where(and(eq(paperFiles.workspaceId, workspaceId), inArray(paperFiles.paperId, ids)))
        ).map((r) => r.id),
      );
      const candidates: string[] = [];
      for (const id of ids) {
        if (!withFile.has(id) && (await openAccessCandidates(workspaceId, id)).length) candidates.push(id);
      }
      if (!candidates.length) {
        return { message: "Not proposed: those papers already have a PDF or have no open-access copy." };
      }
      const same = existing.find((c) => c.kind === "attach_pdfs" && c.status === "proposed");
      const paperIds = [...new Set([...(same?.paperIds ?? []), ...candidates])];
      const change: ProposedChange = {
        id: same?.id ?? randomUUID(),
        kind: "attach_pdfs",
        label: `Add the open-access PDF of ${plural(paperIds.length, "paper")}`,
        paperIds,
        status: "proposed",
      };
      return { change, message: `Proposed change: ${change.label}.` };
    }
  }
}

// ---------------------------------------------------------------------------
// Applying and undoing
// ---------------------------------------------------------------------------

async function applyOne(ctx: RequestContext, c: ProposedChange): Promise<ProposedChange["result"]> {
  const ws = ctx.workspaceId;
  const before = await inLibrary(ws, c.paperIds);
  const savedPaperIds = c.paperIds.filter((id) => !before.has(id));
  switch (c.kind) {
    case "save_papers": {
      const status = (READING_STATUSES as readonly string[]).includes(c.name ?? "")
        ? (c.name as ReadingStatus)
        : "saved";
      for (const id of savedPaperIds) await savePaper(ws, ctx.userId, id, status);
      return { addedPaperIds: savedPaperIds, savedPaperIds };
    }
    case "create_collection":
    case "add_to_collection": {
      let collection = await collectionByName(ws, c.name ?? "");
      let created = false;
      if (!collection) {
        if (c.kind === "add_to_collection") throw new AppError(404, "not_found", "That collection no longer exists.");
        collection = await createCollection(ws, { name: c.name ?? "Untitled", description: c.description });
        created = true;
      }
      const members = new Set(
        (
          await db
            .select({ id: collectionPapers.paperId })
            .from(collectionPapers)
            .where(eq(collectionPapers.collectionId, collection.id))
        ).map((r) => r.id),
      );
      await addToCollection(ws, ctx.userId, collection.id, c.paperIds);
      return {
        collectionId: collection.id,
        created,
        addedPaperIds: c.paperIds.filter((id) => !members.has(id)),
        savedPaperIds,
      };
    }
    case "tag_papers": {
      const names = c.tags ?? [];
      const lower = names.map((n) => n.toLowerCase());
      const existingTags = new Set(
        (
          await db
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.workspaceId, ws), inArray(sql`lower(${tags.name})`, lower)))
        ).map((t) => t.id),
      );
      const pairsBefore = new Set(
        existingTags.size && c.paperIds.length
          ? (
              await db
                .select({ p: paperTags.paperId, t: paperTags.tagId })
                .from(paperTags)
                .where(and(inArray(paperTags.paperId, c.paperIds), inArray(paperTags.tagId, [...existingTags])))
            ).map((r) => `${r.p}:${r.t}`)
          : [],
      );
      await tagPapers(ws, ctx.userId, c.paperIds, { names });
      const after = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.workspaceId, ws), inArray(sql`lower(${tags.name})`, lower)));
      const addedTagPairs = c.paperIds.flatMap((p) =>
        after.filter((t) => !pairsBefore.has(`${p}:${t.id}`)).map((t): [string, string] => [p, t.id]),
      );
      return {
        createdTagIds: after.map((t) => t.id).filter((id) => !existingTags.has(id)),
        addedTagPairs,
        savedPaperIds,
      };
    }
    case "create_concept":
    case "link_concept": {
      let concept = await conceptByName(ws, c.name ?? "");
      let created = false;
      if (!concept) {
        if (c.kind === "link_concept") throw new AppError(404, "not_found", "That concept no longer exists.");
        concept = await createConcept(ctx, { name: c.name ?? "", description: c.description, origin: "ai_suggestion" });
        created = true;
      }
      const linked = new Set(
        (
          await db
            .select({ id: paperConcepts.paperId })
            .from(paperConcepts)
            .where(eq(paperConcepts.conceptId, concept.id))
        ).map((r) => r.id),
      );
      for (const id of c.paperIds) await linkPaper(ctx, concept.id, id);
      return {
        conceptId: concept.id,
        created,
        addedPaperIds: c.paperIds.filter((id) => !linked.has(id)),
        savedPaperIds,
      };
    }
    case "create_note": {
      const note = await createNote(ctx, {
        title: c.name ?? "Untitled",
        paperId: c.paperIds[0] ?? null,
        content: (c.doc as PMNode | undefined) ?? { type: "doc", content: [] },
      });
      return { noteId: note.id };
    }
    case "set_status": {
      const rows = await db
        .select({ paperId: libraryItems.paperId, status: libraryItems.status })
        .from(libraryItems)
        .where(and(eq(libraryItems.workspaceId, ws), inArray(libraryItems.paperId, c.paperIds)));
      const status = (READING_STATUSES as readonly string[]).includes(c.name ?? "")
        ? (c.name as ReadingStatus)
        : "read";
      await setStatus(
        ws,
        rows.map((r) => r.paperId),
        status,
      );
      return { previousStatuses: Object.fromEntries(rows.map((r) => [r.paperId, r.status])) };
    }
    case "remove_from_collection": {
      const collection = await collectionByName(ws, c.name ?? "");
      if (!collection) throw new AppError(404, "not_found", "That collection no longer exists.");
      const members = new Set(await collectionPaperIds(collection.id));
      const removed = c.paperIds.filter((id) => members.has(id));
      await removeFromCollection(ws, collection.id, removed);
      return { collectionId: collection.id, removedPaperIds: removed };
    }
    case "unlink_concept": {
      const concept = await conceptByName(ws, c.name ?? "");
      if (!concept) throw new AppError(404, "not_found", "That concept no longer exists.");
      const linked = new Set(await conceptPaperIds(concept.id));
      const removed = c.paperIds.filter((id) => linked.has(id));
      for (const id of removed) await unlinkPaper(ctx, concept.id, id);
      return { conceptId: concept.id, removedPaperIds: removed };
    }
    case "relate_concepts": {
      // The relations are made by relateAppliedConcepts once every concept of the set exists.
      const concept = await conceptByName(ws, c.name ?? "");
      if (!concept) throw new AppError(404, "not_found", "That concept does not exist.");
      return { conceptId: concept.id };
    }
    case "append_to_note": {
      const note = await loadNote(c.noteId ?? "");
      const before = note.content as PMNode;
      const added = (c.doc as PMNode | undefined)?.content ?? [];
      const saved = await updateNote(ctx, note.id, {
        content: { type: "doc", content: [...(before.content ?? []), ...added] },
      });
      return { noteId: note.id, previousDoc: before, savedAt: saved.updatedAt.toISOString() };
    }
    case "link_note": {
      const note = await loadNote(c.noteId ?? "");
      const before = note.content as PMNode;
      const added = (c.doc as PMNode | undefined)?.content ?? [];
      const saved = await updateNote(ctx, note.id, {
        ...(c.attachPaperId ? { paperId: c.attachPaperId } : {}),
        ...(added.length ? { content: { type: "doc", content: [...(before.content ?? []), ...added] } } : {}),
      });
      return {
        noteId: note.id,
        previousPaperId: note.paperId,
        ...(added.length ? { previousDoc: before } : {}),
        savedAt: saved.updatedAt.toISOString(),
      };
    }
    case "merge_concepts":
      return mergeConcepts(ctx, c.name ?? "", c.fromNames ?? []);
    case "rename_concept": {
      const concept = await conceptByName(ws, c.fromNames?.[0] ?? "");
      if (!concept) throw new AppError(404, "not_found", "That concept no longer exists.");
      const [row] = await db.select().from(concepts).where(eq(concepts.id, concept.id));
      const newName = (c.name ?? "").trim();
      const taken = await conceptByName(ws, newName);
      if (taken && taken.id !== concept.id) throw new AppError(409, "conflict", `“${taken.name}” already exists.`);
      await updateConcept(ctx, concept.id, { name: newName, aliases: [...row.aliases, row.name] });
      return { conceptId: concept.id, previousName: row.name, previousAliases: row.aliases };
    }
    case "edit_note": {
      const note = await loadNote(c.noteId ?? "");
      if (c.noteUpdatedAt && Math.abs(note.updatedAt.getTime() - new Date(c.noteUpdatedAt).getTime()) > 1000) {
        throw new AppError(409, "conflict", "The note changed after this edit was proposed. Ask again to redo it.");
      }
      const before = note.content as PMNode;
      const saved = await updateNote(ctx, note.id, {
        content: applyBlockEdits(before, (c.doc as PlannedEdit[] | undefined) ?? []),
      });
      return { noteId: note.id, previousDoc: before, savedAt: saved.updatedAt.toISOString() };
    }
    case "start_screening": {
      const created = await createScreening(ctx, {
        title: c.name ?? "Screening",
        criteria: c.description ?? "",
        paperIds: c.paperIds,
        useFullText: c.fromNames?.includes("full_text"),
      });
      return { screeningId: created.id };
    }
    case "save_search": {
      const source = (["general", "biomedical", "openreview", "arxiv"] as const).find((s) => s === c.description);
      const saved = await createSavedSearch(ctx, { query: c.name ?? "", source: source ?? "general" });
      return { savedSearchId: saved.id, created: saved.created };
    }
    case "edit_collection": {
      const collection = await collectionByName(ws, c.fromNames?.[0] ?? "");
      if (!collection) throw new AppError(404, "not_found", "That collection no longer exists.");
      const newName = (c.name ?? "").trim();
      await updateCollection(ws, collection.id, {
        ...(newName && newName !== collection.name ? { name: newName } : {}),
        ...(c.description !== undefined ? { description: c.description } : {}),
      });
      return {
        collectionId: collection.id,
        previousName: collection.name,
        previousDescription: collection.description,
      };
    }
    case "delete_collection": {
      const collection = await collectionByName(ws, c.name ?? "");
      if (!collection) throw new AppError(404, "not_found", "That collection no longer exists.");
      const deleted = await snapshotCollection(collection.id);
      await deleteCollection(ws, collection.id);
      return { deleted };
    }
    case "untag_papers": {
      const removed: [string, string][] = [];
      for (const n of c.tags ?? []) {
        const tag = await tagByName(ws, n);
        if (!tag) continue;
        const gone = await db
          .delete(paperTags)
          .where(and(eq(paperTags.tagId, tag.id), inArray(paperTags.paperId, c.paperIds)))
          .returning({ paperId: paperTags.paperId });
        removed.push(...gone.map((g): [string, string] => [g.paperId, tag.id]));
      }
      return { removedTagPairs: removed };
    }
    case "rename_tag": {
      const tag = await tagByName(ws, c.fromNames?.[0] ?? "");
      if (!tag) throw new AppError(404, "not_found", "That tag no longer exists.");
      await updateTag(ws, tag.id, { name: (c.name ?? "").replace(/^#/, "").trim() });
      return { tagId: tag.id, previousName: tag.name };
    }
    case "delete_tag": {
      const tag = await tagByName(ws, c.name ?? "");
      if (!tag) throw new AppError(404, "not_found", "That tag no longer exists.");
      const deleted = await snapshotTag(tag.id);
      await deleteTag(ws, tag.id);
      return { deleted };
    }
    case "edit_concept": {
      const concept = await conceptByName(ws, c.name ?? "");
      if (!concept) throw new AppError(404, "not_found", "That concept no longer exists.");
      const [row] = await db.select().from(concepts).where(eq(concepts.id, concept.id));
      await updateConcept(ctx, concept.id, { description: c.description ?? "" });
      return { conceptId: concept.id, previousDescription: row.description };
    }
    case "delete_concept": {
      const concept = await conceptByName(ws, c.name ?? "");
      if (!concept) throw new AppError(404, "not_found", "That concept no longer exists.");
      const deleted = await snapshotConcept(concept.id);
      await deleteConcept(ctx, concept.id);
      return { deleted };
    }
    case "remove_from_library": {
      const saved = await inLibrary(ws, c.paperIds);
      const removed = c.paperIds.filter((id) => saved.has(id));
      const deleted = await snapshotLibrary(ws, removed);
      await removeFromLibrary(ws, removed);
      return { deleted, removedPaperIds: removed };
    }
    case "stop_following": {
      const search = await savedSearchByQuery(ws, c.name ?? "");
      if (!search) throw new AppError(404, "not_found", "You no longer follow that search.");
      const deleted = await snapshotSavedSearch(search.id);
      await deleteSavedSearch(ws, search.id);
      return { deleted };
    }
    case "add_highlight": {
      if (!c.highlight) throw new AppError(400, "bad_request", "Nothing to highlight.");
      const h = await createHighlight(ws, ctx.userId, c.highlight.fileId, { kind: "highlight", ...c.highlight });
      return { highlightId: h.id };
    }
    case "attach_pdfs": {
      const fileIds: string[] = [];
      const failedPaperIds: string[] = [];
      for (const id of c.paperIds) {
        try {
          fileIds.push((await attachPdfFromUrl(ws, ctx.userId, id)).id);
        } catch {
          failedPaperIds.push(id);
        }
      }
      if (!fileIds.length) throw new AppError(502, "pdf_unavailable", "None of the PDFs could be downloaded.");
      return { fileIds, failedPaperIds };
    }
  }
}

/** Applies the given proposals in order; each records its own result or error. */
export async function applyChanges(ctx: RequestContext, items: ProposedChange[]): Promise<ProposedChange[]> {
  const out: ProposedChange[] = [];
  for (const c of items) {
    if (c.status !== "proposed") {
      out.push(c);
      continue;
    }
    try {
      out.push({ ...c, status: "applied", error: undefined, result: await applyOne(ctx, c) });
    } catch (err) {
      out.push({ ...c, status: "failed", error: errorText(err) });
    }
  }
  return relateAppliedConcepts(ctx, out);
}

/**
 * Connects applied concepts to the broader concepts they were proposed under, once all of the set's
 * concepts exist (so the order of the proposals does not matter). Relations made are kept for undo.
 */
async function relateAppliedConcepts(ctx: RequestContext, items: ProposedChange[]) {
  const out = [...items];
  for (const [i, c] of out.entries()) {
    const conceptId = c.result?.conceptId;
    if (c.status !== "applied" || !conceptId || !c.related?.length) continue;
    const pairs: [string, string][] = [];
    for (const n of c.related) {
      const other = await conceptByName(ctx.workspaceId, n);
      if (!other || other.id === conceptId || (await conceptsRelated(conceptId, other.id))) continue;
      await relateConcepts(ctx, conceptId, other.id, true);
      pairs.push([conceptId, other.id]);
    }
    if (pairs.length) {
      out[i] = { ...c, result: { ...c.result, relatedPairs: [...(c.result?.relatedPairs ?? []), ...pairs] } };
    }
  }
  return out;
}

async function conceptsRelated(a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const [row] = await db
    .select({ a: conceptRelations.conceptAId })
    .from(conceptRelations)
    .where(and(eq(conceptRelations.conceptAId, x), eq(conceptRelations.conceptBId, y)));
  return !!row;
}

// ---------------------------------------------------------------------------
// Merging concepts
// ---------------------------------------------------------------------------

/** What merge_concepts changed, so undo can bring the merged concepts back exactly. */
interface MergeRecord {
  intoId: string;
  previousAliases: string[];
  addedPaperIds: string[];
  addedRelatedIds: string[];
  removed: {
    concept: typeof concepts.$inferSelect;
    paperLinks: { paperId: string; createdBy: string | null }[];
    relatedIds: string[];
  }[];
  notes: { id: string; previousDoc: unknown; savedAt: string }[];
}

/** A note's content with links to the merged concepts pointing to the concept they were merged into. */
function retargetMentions(doc: PMNode, fromIds: Set<string>, into: { id: string; name: string }): PMNode {
  const copy = structuredClone(doc);
  walk(copy, (n) => {
    if (n.type !== "mention") return;
    const ref = parseMentionId(n.attrs?.id);
    if (ref?.type === "concept" && fromIds.has(ref.id))
      n.attrs = { ...n.attrs, id: `concept:${into.id}`, label: into.name };
  });
  return copy;
}

async function relatedIds(conceptId: string) {
  const rows = await db
    .select({ a: conceptRelations.conceptAId, b: conceptRelations.conceptBId })
    .from(conceptRelations)
    .where(sql`${conceptRelations.conceptAId} = ${conceptId} or ${conceptRelations.conceptBId} = ${conceptId}`);
  return rows.map((r) => (r.a === conceptId ? r.b : r.a));
}

/**
 * Merges concepts into one: their papers, related concepts and the notes that mention them move to
 * `intoName`, their names become its aliases, and they are deleted.
 */
async function mergeConcepts(ctx: RequestContext, intoName: string, fromNames: string[]) {
  const ws = ctx.workspaceId;
  const into = await conceptByName(ws, intoName);
  if (!into) throw new AppError(404, "not_found", `The concept “${intoName}” no longer exists.`);
  const [intoRow] = await db.select().from(concepts).where(eq(concepts.id, into.id));
  const fromRows: (typeof concepts.$inferSelect)[] = [];
  for (const n of fromNames) {
    const found = await conceptByName(ws, n);
    if (!found) throw new AppError(404, "not_found", `The concept “${n}” no longer exists.`);
    if (found.id === into.id || fromRows.some((r) => r.id === found.id)) continue;
    const [row] = await db.select().from(concepts).where(eq(concepts.id, found.id));
    fromRows.push(row);
  }
  const fromIds = new Set(fromRows.map((r) => r.id));
  const record: MergeRecord = {
    intoId: into.id,
    previousAliases: intoRow.aliases,
    addedPaperIds: [],
    addedRelatedIds: [],
    removed: [],
    notes: [],
  };
  const intoPapers = new Set(await conceptPaperIds(into.id));
  const intoRelated = new Set(await relatedIds(into.id));
  for (const row of fromRows) {
    const paperLinks = await db
      .select({ paperId: paperConcepts.paperId, createdBy: paperConcepts.createdBy })
      .from(paperConcepts)
      .where(eq(paperConcepts.conceptId, row.id));
    const related = await relatedIds(row.id);
    record.removed.push({ concept: row, paperLinks, relatedIds: related });
    for (const { paperId } of paperLinks) {
      if (intoPapers.has(paperId)) continue;
      await db
        .insert(paperConcepts)
        .values({ conceptId: into.id, paperId, createdBy: ctx.userId })
        .onConflictDoNothing();
      intoPapers.add(paperId);
      record.addedPaperIds.push(paperId);
    }
    for (const other of related) {
      if (other === into.id || fromIds.has(other) || intoRelated.has(other)) continue;
      await relateConcepts(ctx, into.id, other, true);
      intoRelated.add(other);
      record.addedRelatedIds.push(other);
    }
  }
  // Notes that mention a merged concept now mention the one it was merged into.
  const noteIds = fromIds.size
    ? (
        await db
          .selectDistinct({ id: noteLinks.noteId })
          .from(noteLinks)
          .innerJoin(notes, eq(notes.id, noteLinks.noteId))
          .where(and(eq(notes.workspaceId, ws), inArray(noteLinks.targetConceptId, [...fromIds])))
      ).map((r) => r.id)
    : [];
  for (const id of noteIds) {
    const note = await loadNote(id);
    const saved = await updateNote(ctx, id, {
      content: retargetMentions(note.content as PMNode, fromIds, { id: into.id, name: into.name }),
    });
    record.notes.push({ id, previousDoc: note.content, savedAt: saved.updatedAt.toISOString() });
  }
  const aliases = [...intoRow.aliases, ...fromRows.flatMap((r) => [r.name, ...r.aliases])];
  for (const row of fromRows) await deleteConcept(ctx, row.id);
  await updateConcept(ctx, into.id, { aliases });
  return { conceptId: into.id, merged: record };
}

/** Brings merged concepts back with their ids, papers, relations and notes (notes edited since are left). */
async function unmergeConcepts(ctx: RequestContext, record: MergeRecord | undefined) {
  if (!record) return;
  const ws = ctx.workspaceId;
  await updateConcept(ctx, record.intoId, { aliases: record.previousAliases });
  for (const { concept } of record.removed) {
    // The search vector is computed by the database.
    const { searchVector: _computed, ...row } = concept;
    await db
      .insert(concepts)
      .values({ ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })
      .onConflictDoNothing();
  }
  for (const { concept, paperLinks, relatedIds: related } of record.removed) {
    for (const l of paperLinks) {
      await db
        .insert(paperConcepts)
        .values({ conceptId: concept.id, paperId: l.paperId, createdBy: l.createdBy })
        .onConflictDoNothing();
    }
    for (const other of related) await relateConcepts(ctx, concept.id, other, true).catch(() => {});
  }
  if (record.addedPaperIds.length) {
    await db
      .delete(paperConcepts)
      .where(and(eq(paperConcepts.conceptId, record.intoId), inArray(paperConcepts.paperId, record.addedPaperIds)));
  }
  for (const other of record.addedRelatedIds) await relateConcepts(ctx, record.intoId, other, false).catch(() => {});
  for (const n of record.notes) {
    const note = await loadNote(n.id).catch(() => null);
    if (!note || note.workspaceId !== ws) continue;
    if (Math.abs(note.updatedAt.getTime() - new Date(n.savedAt).getTime()) > 1000) continue;
    await updateNote(ctx, n.id, { content: n.previousDoc });
  }
}

async function undoOne(ctx: RequestContext, c: ProposedChange) {
  const r = c.result ?? {};
  const ws = ctx.workspaceId;
  switch (c.kind) {
    case "save_papers":
      break;
    case "create_collection":
    case "add_to_collection":
      if (r.collectionId && r.created) await deleteCollection(ws, r.collectionId);
      else if (r.collectionId && r.addedPaperIds?.length)
        await removeFromCollection(ws, r.collectionId, r.addedPaperIds);
      break;
    case "tag_papers":
      for (const [paperId, tagId] of r.addedTagPairs ?? []) {
        await db.delete(paperTags).where(and(eq(paperTags.paperId, paperId), eq(paperTags.tagId, tagId)));
      }
      if (r.createdTagIds?.length) {
        await db.delete(tags).where(and(eq(tags.workspaceId, ws), inArray(tags.id, r.createdTagIds)));
      }
      break;
    case "create_concept":
    case "link_concept":
      // Relations to broader concepts go first (a deleted concept takes its relations with it).
      for (const [a, b] of r.relatedPairs ?? []) await relateConcepts(ctx, a, b, false).catch(() => {});
      if (r.conceptId && r.created) await deleteConcept(ctx, r.conceptId);
      else if (r.conceptId) for (const id of r.addedPaperIds ?? []) await unlinkPaper(ctx, r.conceptId, id);
      break;
    case "create_note":
      if (r.noteId) await deleteNote(ctx, r.noteId);
      break;
    case "attach_pdfs":
      for (const id of r.fileIds ?? []) await deleteFile(ws, id).catch(() => {});
      break;
    case "set_status": {
      const byStatus = new Map<ReadingStatus, string[]>();
      for (const [paperId, status] of Object.entries(r.previousStatuses ?? {})) {
        byStatus.set(status, [...(byStatus.get(status) ?? []), paperId]);
      }
      for (const [status, ids] of byStatus) await setStatus(ws, ids, status);
      break;
    }
    case "remove_from_collection":
      if (r.collectionId && r.removedPaperIds?.length) {
        await addToCollection(ws, ctx.userId, r.collectionId, r.removedPaperIds);
      }
      break;
    case "unlink_concept":
      for (const id of r.removedPaperIds ?? []) if (r.conceptId) await linkPaper(ctx, r.conceptId, id);
      break;
    case "relate_concepts":
      for (const [a, b] of r.relatedPairs ?? []) await relateConcepts(ctx, a, b, false).catch(() => {});
      break;
    case "merge_concepts":
      await unmergeConcepts(ctx, r.merged as MergeRecord | undefined);
      break;
    case "add_highlight":
      if (r.highlightId) await deleteHighlight(ws, r.highlightId).catch(() => {});
      break;
    case "save_search":
      if (r.savedSearchId && r.created) await deleteSavedSearch(ws, r.savedSearchId).catch(() => {});
      break;
    case "start_screening":
      if (r.screeningId) await deleteScreening(ws, r.screeningId).catch(() => {});
      break;
    case "rename_concept":
      if (r.conceptId && r.previousName !== undefined) {
        await updateConcept(ctx, r.conceptId, { name: r.previousName, aliases: r.previousAliases ?? [] });
      }
      break;
    case "edit_collection":
      if (r.collectionId) {
        await updateCollection(ws, r.collectionId, {
          ...(r.previousName ? { name: r.previousName } : {}),
          ...(r.previousDescription !== undefined ? { description: r.previousDescription } : {}),
        });
      }
      break;
    case "rename_tag":
      if (r.tagId && r.previousName) await updateTag(ws, r.tagId, { name: r.previousName });
      break;
    case "edit_concept":
      if (r.conceptId && r.previousDescription !== undefined) {
        await updateConcept(ctx, r.conceptId, { description: r.previousDescription });
      }
      break;
    case "untag_papers":
      if (r.removedTagPairs?.length) {
        await db
          .insert(paperTags)
          .values(r.removedTagPairs.map(([paperId, tagId]) => ({ paperId, tagId })))
          .onConflictDoNothing();
      }
      break;
    case "delete_collection":
    case "delete_tag":
    case "delete_concept":
    case "remove_from_library":
    case "stop_following":
      await restoreSnapshot(r.deleted);
      break;
    case "edit_note":
    case "append_to_note": {
      if (!r.noteId || !r.previousDoc) break;
      const note = await loadNote(r.noteId);
      // Only when the note was not edited after the change; otherwise those edits would be lost.
      if (r.savedAt && Math.abs(note.updatedAt.getTime() - new Date(r.savedAt).getTime()) > 1000) {
        throw new AppError(409, "conflict", "The note was edited after this change; remove the added text by hand.");
      }
      await updateNote(ctx, r.noteId, { content: r.previousDoc });
      break;
    }
    case "link_note": {
      if (!r.noteId) break;
      const note = await loadNote(r.noteId);
      if (r.previousDoc && r.savedAt && Math.abs(note.updatedAt.getTime() - new Date(r.savedAt).getTime()) > 1000) {
        throw new AppError(409, "conflict", "The note was edited after this change; remove the added links by hand.");
      }
      await updateNote(ctx, r.noteId, {
        ...(c.attachPaperId ? { paperId: r.previousPaperId ?? null } : {}),
        ...(r.previousDoc ? { content: r.previousDoc } : {}),
      });
      break;
    }
  }
  // Papers this change saved to the library are removed again.
  if (r.savedPaperIds?.length) await removeFromLibrary(ws, r.savedPaperIds);
}

/** Undoes applied changes in reverse order. */
export async function undoChanges(ctx: RequestContext, items: ProposedChange[]): Promise<ProposedChange[]> {
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const c = out[i];
    if (c.status !== "applied") continue;
    try {
      await undoOne(ctx, c);
      out[i] = { ...c, status: "undone", error: undefined };
    } catch (err) {
      out[i] = { ...c, error: `Could not undo: ${errorText(err)}` };
    }
  }
  return out;
}
