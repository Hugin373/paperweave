import { handler, requireContext } from "@/server/http";
import { listWorkspaceJobs, toJobDto } from "@/server/jobs/queue";

export const GET = handler(async () => {
  const ctx = await requireContext();
  return (await listWorkspaceJobs(ctx.workspaceId)).map(toJobDto);
});
