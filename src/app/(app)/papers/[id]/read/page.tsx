import type { Metadata } from "next";
import { ReaderScreen } from "@/components/reader/reader-screen";

export const metadata: Metadata = { title: "Reader" };

const UUID = /^[0-9a-f-]{36}$/i;

function one(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

export default async function ReadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const file = one(sp.file);
  const highlight = one(sp.highlight);
  const page = Number(one(sp.page));
  const panel = one(sp.panel);
  return (
    <ReaderScreen
      key={id}
      paperId={id}
      initialFileId={file && UUID.test(file) ? file : null}
      initialPage={Number.isInteger(page) && page > 0 ? page : null}
      highlightId={highlight && UUID.test(highlight) ? highlight : null}
      initialTab={panel === "notes" || panel === "ai" ? panel : "highlights"}
    />
  );
}
