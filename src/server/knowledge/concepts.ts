import { and, desc, eq, or, sql } from "drizzle-orm";
import type { ConceptDetail, ConceptRef, ConceptSummary } from "@/lib/types";
import { db } from "@/server/db/client";
import { conceptRelations, concepts, noteLinks, notes, paperConcepts, papers } from "@/server/db/schema";
import { badRequest, conflict, notFound, type RequestContext } from "@/server/http";
import { savePaper } from "@/server/library/library";
import { getPaperSummaries, getVisiblePaper, toNoteSummary } from "@/server/papers/service";
import { requireAccess } from "@/server/sharing/access";

type ConceptRow = typeof concepts.$inferSelect;

const paperCountSql =
  sql<number>`(select count(*) from ${paperConcepts} where ${paperConcepts.conceptId} = ${concepts.id})`.mapWith(
    Number,
  );
const noteCountSql =
  sql<number>`(select count(*) from ${noteLinks} where ${noteLinks.targetConceptId} = ${concepts.id})`.mapWith(Number);

function toSummary(r: ConceptRow & { paperCount: number; noteCount: number }): ConceptSummary {
  return {
    id: r.id,
    name: r.name,
    aliases: r.aliases,
    description: r.description,
    origin: r.origin,
    paperCount: r.paperCount,
    noteCount: r.noteCount,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function loadConcept(id: string): Promise<ConceptRow> {
  const [row] = await db.select().from(concepts).where(eq(concepts.id, id));
  if (!row) throw notFound("Concept");
  return row;
}

export async function listConcepts(workspaceId: string, q?: string): Promise<ConceptSummary[]> {
  const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db
    .select({ concept: concepts, paperCount: paperCountSql, noteCount: noteCountSql })
    .from(concepts)
    .where(
      and(
        eq(concepts.workspaceId, workspaceId),
        like
          ? sql`(${concepts.name} ilike ${like} or ${concepts.description} ilike ${like} or exists (select 1 from unnest(${concepts.aliases}) a where a ilike ${like}))`
          : undefined,
      ),
    )
    .orderBy(sql`lower(${concepts.name})`);
  return rows.map((r) => toSummary({ ...r.concept, paperCount: r.paperCount, noteCount: r.noteCount }));
}

function cleanAliases(aliases: string[] | undefined, name: string) {
  return [...new Set((aliases ?? []).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase()))];
}

export async function createConcept(
  ctx: RequestContext,
  input: {
    name: string;
    description?: string;
    aliases?: string[];
    origin?: "user" | "ai_suggestion";
    paperId?: string;
  },
): Promise<ConceptRow> {
  const name = input.name.trim();
  if (!name) throw badRequest("Concept name is required.");
  const [existing] = await db
    .select()
    .from(concepts)
    .where(and(eq(concepts.workspaceId, ctx.workspaceId), sql`lower(${concepts.name}) = ${name.toLowerCase()}`));
  if (existing) throw conflict(`A concept named "${existing.name}" already exists.`);
  const [row] = await db
    .insert(concepts)
    .values({
      workspaceId: ctx.workspaceId,
      name,
      description: input.description?.trim() ?? "",
      aliases: cleanAliases(input.aliases, name),
      origin: input.origin ?? "user",
      createdBy: ctx.userId,
    })
    .returning();
  if (input.paperId) await linkPaper(ctx, row.id, input.paperId);
  return row;
}

export async function updateConcept(
  ctx: RequestContext,
  id: string,
  patch: { name?: string; description?: string; aliases?: string[] },
) {
  const concept = await loadConcept(id);
  const access = await requireAccess(ctx, "concept", id, concept.workspaceId, "edit", "Concept");
  if (patch.name !== undefined && access !== "owner") throw badRequest("Only the owner can rename a concept.");
  const name = patch.name?.trim() ?? concept.name;
  try {
    const [row] = await db
      .update(concepts)
      .set({
        name,
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.aliases !== undefined ? { aliases: cleanAliases(patch.aliases, name) } : {}),
      })
      .where(eq(concepts.id, id))
      .returning();
    return row;
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
      throw conflict("A concept with that name already exists.");
    }
    throw err;
  }
}

export async function deleteConcept(ctx: RequestContext, id: string) {
  const concept = await loadConcept(id);
  await requireAccess(ctx, "concept", id, concept.workspaceId, "owner", "Concept");
  await db.delete(concepts).where(eq(concepts.id, id));
}

/** Links a paper and a concept. The paper is saved to the library so the link is visible. */
export async function linkPaper(ctx: RequestContext, conceptId: string, paperId: string) {
  const concept = await loadConcept(conceptId);
  await requireAccess(ctx, "concept", conceptId, concept.workspaceId, "owner", "Concept");
  await getVisiblePaper(ctx.workspaceId, paperId);
  await savePaper(ctx.workspaceId, ctx.userId, paperId);
  await db.insert(paperConcepts).values({ conceptId, paperId, createdBy: ctx.userId }).onConflictDoNothing();
}

export async function unlinkPaper(ctx: RequestContext, conceptId: string, paperId: string) {
  const concept = await loadConcept(conceptId);
  await requireAccess(ctx, "concept", conceptId, concept.workspaceId, "owner", "Concept");
  await db.delete(paperConcepts).where(and(eq(paperConcepts.conceptId, conceptId), eq(paperConcepts.paperId, paperId)));
}

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function relateConcepts(ctx: RequestContext, a: string, b: string, related: boolean) {
  if (a === b) throw badRequest("A concept cannot be related to itself.");
  const [ca, cb] = await Promise.all([loadConcept(a), loadConcept(b)]);
  if (ca.workspaceId !== cb.workspaceId) throw notFound("Concept");
  await requireAccess(ctx, "concept", a, ca.workspaceId, "owner", "Concept");
  const [x, y] = ordered(a, b);
  if (related) {
    await db.insert(conceptRelations).values({ conceptAId: x, conceptBId: y }).onConflictDoNothing();
  } else {
    await db
      .delete(conceptRelations)
      .where(and(eq(conceptRelations.conceptAId, x), eq(conceptRelations.conceptBId, y)));
  }
}

export async function relatedConcepts(conceptId: string): Promise<ConceptRef[]> {
  const rows = await db
    .select({ id: concepts.id, name: concepts.name })
    .from(conceptRelations)
    .innerJoin(
      concepts,
      or(
        and(eq(conceptRelations.conceptAId, conceptId), eq(concepts.id, conceptRelations.conceptBId)),
        and(eq(conceptRelations.conceptBId, conceptId), eq(concepts.id, conceptRelations.conceptAId)),
      ),
    )
    .orderBy(concepts.name);
  return rows;
}

export async function getConceptDetail(ctx: RequestContext, id: string): Promise<ConceptDetail> {
  const concept = await loadConcept(id);
  const access = await requireAccess(ctx, "concept", id, concept.workspaceId, "view", "Concept");
  const isMember = concept.workspaceId === ctx.workspaceId;
  const [paperRows, noteRows, related, [counts]] = await Promise.all([
    db
      .select({ paperId: paperConcepts.paperId })
      .from(paperConcepts)
      .where(eq(paperConcepts.conceptId, id))
      .orderBy(desc(paperConcepts.createdAt)),
    isMember
      ? db
          .select({
            id: notes.id,
            title: notes.title,
            text: notes.contentText,
            paperId: notes.paperId,
            paperTitle: papers.title,
            updatedAt: notes.updatedAt,
          })
          .from(noteLinks)
          .innerJoin(notes, eq(notes.id, noteLinks.noteId))
          .leftJoin(papers, eq(papers.id, notes.paperId))
          .where(and(eq(noteLinks.targetConceptId, id), eq(notes.workspaceId, concept.workspaceId)))
          .orderBy(desc(notes.updatedAt))
      : [],
    isMember ? relatedConcepts(id) : [],
    db.select({ paperCount: paperCountSql, noteCount: noteCountSql }).from(concepts).where(eq(concepts.id, id)),
  ]);
  // Papers are shown with the viewer's own library state; owner-private papers stay hidden.
  const paperSummaries = await getPaperSummaries(
    isMember ? ctx.workspaceId : concept.workspaceId,
    paperRows.map((r) => r.paperId),
  );
  return {
    ...toSummary({ ...concept, paperCount: counts.paperCount, noteCount: counts.noteCount }),
    papers: isMember ? paperSummaries : paperSummaries.map((p) => ({ ...p, library: null })),
    notes: noteRows.map(toNoteSummary),
    related,
    access,
  };
}
