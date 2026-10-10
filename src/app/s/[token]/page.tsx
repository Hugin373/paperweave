import { BookOpen, FolderOpen, Lightbulb, NotebookPen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Markdown } from "@/components/ui/markdown";
import { formatAuthors } from "@/lib/format";
import { docToMarkdown, type PMNode } from "@/lib/prosemirror";
import type { PaperSummary } from "@/lib/types";
import { AppError } from "@/server/http";
import { publicShare } from "@/server/sharing/public";

export const metadata: Metadata = { title: "Shared from Paperweave", robots: { index: false } };
export const dynamic = "force-dynamic";

function PaperList({ papers }: { papers: PaperSummary[] }) {
  if (!papers.length) return <p className="text-sm text-muted">No papers.</p>;
  return (
    <ul className="space-y-3">
      {papers.map((p) => {
        const href = p.ids.doi
          ? `https://doi.org/${p.ids.doi}`
          : p.ids.arxiv
            ? `https://arxiv.org/abs/${p.ids.arxiv}`
            : null;
        return (
          <li key={p.id} className="rounded-xl border border-border bg-surface p-4">
            <p className="font-serif text-[16px] font-semibold">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline">
                  {p.title}
                </a>
              ) : (
                p.title
              )}
            </p>
            <p className="mt-0.5 text-[13px] text-muted">
              {[formatAuthors(p.authors), p.venue, p.year].filter(Boolean).join(" · ")}
            </p>
            {p.abstract && <p className="mt-2 line-clamp-3 text-[13.5px] text-text/85">{p.abstract}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export default async function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let data: Awaited<ReturnType<typeof publicShare>> | null = null;
  try {
    data = await publicShare(token);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface/60">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent">
            <BookOpen className="size-4" aria-hidden />
          </span>
          <span className="font-semibold">Paperweave</span>
          <span className="ml-auto text-xs text-muted">Shared read-only</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        {!data ? (
          <div className="py-20 text-center">
            <h1 className="text-xl font-semibold">This link is no longer available</h1>
            <p className="mt-2 text-sm text-muted">The owner may have stopped sharing it.</p>
          </div>
        ) : data.type === "collection" ? (
          <article className="space-y-5">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <FolderOpen className="size-5 text-muted" aria-hidden />
              {data.collection.name}
            </h1>
            {data.collection.description && <p className="text-muted">{data.collection.description}</p>}
            <PaperList papers={data.collection.papers} />
          </article>
        ) : data.type === "note" ? (
          <article className="space-y-4">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <NotebookPen className="size-5 text-muted" aria-hidden />
              {data.note.title}
            </h1>
            {data.note.paperTitle && <p className="text-sm text-muted">Note on “{data.note.paperTitle}”</p>}
            <div className="rounded-xl border border-border bg-surface p-6">
              <Markdown className="text-[15px]">{docToMarkdown(data.note.content as PMNode)}</Markdown>
            </div>
          </article>
        ) : (
          <article className="space-y-5">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Lightbulb className="size-5 text-muted" aria-hidden />
              {data.concept.name}
            </h1>
            {data.concept.aliases.length > 0 && (
              <p className="text-sm text-muted">Also known as {data.concept.aliases.join(", ")}</p>
            )}
            {data.concept.description && <p className="whitespace-pre-line">{data.concept.description}</p>}
            <h2 className="pt-2 text-sm font-semibold tracking-wide text-muted uppercase">Related papers</h2>
            <PaperList papers={data.concept.papers} />
          </article>
        )}
        <p className="mt-12 text-center text-xs text-subtle">
          <Link href="/register" className="hover:underline">
            Build your own research knowledge base with Paperweave
          </Link>
        </p>
      </main>
    </div>
  );
}
