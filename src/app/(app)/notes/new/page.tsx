import { NewNote } from "@/components/notes/new-note";

export default async function NewNotePage({ searchParams }: { searchParams: Promise<{ paperId?: string }> }) {
  const { paperId } = await searchParams;
  const valid = paperId && /^[0-9a-f-]{36}$/i.test(paperId) ? paperId : undefined;
  return <NewNote paperId={valid} />;
}
