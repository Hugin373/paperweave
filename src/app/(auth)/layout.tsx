import { BookOpen, Network, NotebookPen, Search } from "lucide-react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/http";

const POINTS = [
  { icon: Search, text: "Discover papers by topic, title, author, DOI or arXiv link" },
  { icon: Network, text: "Follow references and citations through research lineage" },
  { icon: NotebookPen, text: "Read, highlight and write notes that link papers and concepts" },
];

// Always rendered per request (session-dependent; no build-time secrets needed).
export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getSessionUser()) redirect("/search");
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between border-r border-border bg-surface-2/60 p-12 lg:flex">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent">
            <BookOpen className="size-4" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">Paperweave</span>
        </div>
        <div className="max-w-md">
          <h1 className="font-serif text-3xl leading-tight font-semibold">Your research, woven together.</h1>
          <p className="mt-3 text-muted">
            Find the important papers on a topic, understand them, and build a connected knowledge base you can take
            anywhere.
          </p>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <span className="rounded-lg bg-surface p-2 text-accent shadow-xs">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="pt-1.5">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-subtle">Works without AI. Bring your own model if you want one.</p>
      </section>
      <main className="flex items-center justify-center p-6">{children}</main>
    </div>
  );
}
