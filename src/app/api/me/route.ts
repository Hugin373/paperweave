import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { MeResponse } from "@/lib/types";
import { getAiConfigRow } from "@/server/ai/config";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";
import { handler, parseBody, requireContext } from "@/server/http";
import { resetSingleUserCache } from "@/server/single-user";

export const GET = handler(async (): Promise<MeResponse> => {
  const ctx = await requireContext();
  const [[user], [stats], ai] = await Promise.all([
    db.select({ dismissed: users.onboardingDismissedAt }).from(users).where(eq(users.id, ctx.userId)),
    db.execute<{ papers: number; notes: number; concepts: number; highlights: number }>(sql`
      select (select count(*) from library_items where workspace_id = ${ctx.workspaceId})::int as papers,
             (select count(*) from notes where workspace_id = ${ctx.workspaceId})::int as notes,
             (select count(*) from concepts where workspace_id = ${ctx.workspaceId})::int as concepts,
             (select count(*) from highlights where workspace_id = ${ctx.workspaceId})::int as highlights`),
    getAiConfigRow(ctx.workspaceId),
  ]);
  return {
    user: { id: ctx.userId, name: ctx.userName, email: ctx.userEmail },
    workspace: { id: ctx.workspaceId, name: "", role: ctx.role },
    onboardingDismissed: !!user?.dismissed,
    stats: { papers: stats.papers, notes: stats.notes, concepts: stats.concepts, highlights: stats.highlights },
    ai: { configured: !!ai, enabled: !!ai?.enabled },
    singleUser: !!env().SINGLE_USER_EMAIL,
  };
});

export const PATCH = handler(async (req) => {
  const ctx = await requireContext();
  const body = await parseBody(
    req,
    z.object({ onboardingDismissed: z.boolean().optional(), name: z.string().trim().min(1).max(100).optional() }),
  );
  await db
    .update(users)
    .set({
      ...(body.onboardingDismissed !== undefined
        ? { onboardingDismissedAt: body.onboardingDismissed ? new Date() : null }
        : {}),
      ...(body.name ? { name: body.name } : {}),
    })
    .where(eq(users.id, ctx.userId));
  if (body.name) resetSingleUserCache();
  return { ok: true };
});
