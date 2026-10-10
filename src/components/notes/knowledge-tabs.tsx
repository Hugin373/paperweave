import Link from "next/link";
import { cn } from "@/lib/cn";

/** Tabs that join the Notes and Concepts areas (both live under "Notes" in the sidebar). */
export function KnowledgeTabs({ active }: { active: "notes" | "concepts" }) {
  const tab = (key: "notes" | "concepts", href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active === key ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Knowledge" className="flex gap-1 border-b border-border">
      {tab("notes", "/notes", "Notes")}
      {tab("concepts", "/concepts", "Concepts")}
    </nav>
  );
}
