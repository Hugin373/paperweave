import { and, eq } from "drizzle-orm";
import type { OpenReviewInfoDto } from "@/lib/types";
import { db } from "@/server/db/client";
import { paperIdentifiers } from "@/server/db/schema";
import { scholarly } from "@/server/scholarly/service";
import { getVisiblePaper } from "./service";

/**
 * The paper's OpenReview forum, matched by exact title (venue, decision, and reviews when an account
 * is configured). The forum id is remembered as an identifier, so its PDF can be fetched later.
 */
export async function openReviewForPaper(workspaceId: string, paperId: string): Promise<OpenReviewInfoDto | null> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  if (paper.ownerWorkspaceId !== null) return null;
  const info = await scholarly()
    .openReviewFor(paper.title)
    .catch(() => null);
  if (!info) return null;
  const [known] = await db
    .select({ paperId: paperIdentifiers.paperId })
    .from(paperIdentifiers)
    .where(
      and(
        eq(paperIdentifiers.scope, "global"),
        eq(paperIdentifiers.kind, "openreview"),
        eq(paperIdentifiers.value, info.forumId),
      ),
    );
  if (!known) {
    await db
      .insert(paperIdentifiers)
      .values({ paperId, kind: "openreview", value: info.forumId, scope: "global" })
      .onConflictDoNothing();
  }
  return {
    forumId: info.forumId,
    url: info.url,
    venue: info.venue,
    decision: info.decision,
    reviews: info.reviews,
    reviewsLoaded: info.reviewsLoaded,
  };
}
