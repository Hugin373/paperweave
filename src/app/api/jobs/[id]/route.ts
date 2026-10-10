import { z } from "zod";
import { handler, notFound, requireContext } from "@/server/http";
import { getWorkspaceJob, toJobDto } from "@/server/jobs/queue";

export const GET = handler<{ id: string }>(async (_req, { id }) => {
  const ctx = await requireContext();
  const job = await getWorkspaceJob(ctx.workspaceId, z.coerce.number().int().positive().parse(id));
  if (!job) throw notFound("Job");
  return toJobDto(job);
});
