/** Read-only content behind public share links (no sign-in required). */
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { concepts, notes, paperConcepts, papers } from "@/server/db/schema";
import { notFound } from "@/server/http";
import { getPaperSummaries } from "@/server/papers/service";
import { collectionView, getByLinkToken } from "./shares";

export async function publicShare(token: string) {
  const share = await getByLinkToken(token);
  if (share.resourceType === "collection") {
    const view = await collectionView(share.resourceId, null, "view");
    return { type: "collection" as const, collection: view };
  }
  if (share.resourceType === "note") {
    const [note] = await db
      .select({ title: notes.title, content: notes.content, updatedAt: notes.updatedAt, paperTitle: papers.title })
      .from(notes)
      .leftJoin(papers, eq(papers.id, notes.paperId))
      .where(eq(notes.id, share.resourceId));
    if (!note) throw notFound("Shared item");
    return {
      type: "note" as const,
      note: {
        title: note.title || "Untitled note",
        content: note.content,
        paperTitle: note.paperTitle,
        updatedAt: note.updatedAt.toISOString(),
      },
    };
  }
  const [concept] = await db.select().from(concepts).where(eq(concepts.id, share.resourceId));
  if (!concept) throw notFound("Shared item");
  const linked = await db
    .select({ paperId: paperConcepts.paperId })
    .from(paperConcepts)
    .where(eq(paperConcepts.conceptId, concept.id));
  const paperList = await getPaperSummaries(
    concept.workspaceId,
    linked.map((l) => l.paperId),
  );
  return {
    type: "concept" as const,
    concept: {
      name: concept.name,
      aliases: concept.aliases,
      description: concept.description,
      papers: paperList.map((p) => ({ ...p, library: null })),
    },
  };
}
