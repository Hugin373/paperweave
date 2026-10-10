import type { Metadata } from "next";
import { ResearchHome } from "@/components/research/research-home";

export const metadata: Metadata = { title: "Assistant" };

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const uuid = /^[0-9a-f-]{36}$/i;
  return (
    <ResearchHome
      initialQuestion={one(sp.q).slice(0, 4000)}
      initialPaperIds={one(sp.papers)
        .split(",")
        .filter((id) => uuid.test(id))
        .slice(0, 30)}
      initialCollectionId={uuid.test(one(sp.collection)) ? one(sp.collection) : null}
    />
  );
}
