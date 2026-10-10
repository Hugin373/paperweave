"use client";

import { ExternalLink, LockOpen, Quote } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatAuthors, formatCount, PUBLICATION_TYPE_LABEL } from "@/lib/format";
import type { PaperSummary } from "@/lib/types";

export function PaperMeta({ paper, className }: { paper: PaperSummary; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted", className)}>
      <span className="min-w-0">{formatAuthors(paper.authors)}</span>
      {(paper.venue || paper.year) && <span aria-hidden>·</span>}
      {paper.venue && <span className="max-w-[22rem] truncate italic">{paper.venue}</span>}
      {paper.year && <span>{paper.year}</span>}
    </div>
  );
}

export function PaperBadges({ paper }: { paper: PaperSummary }) {
  const type = paper.publicationTypes.find((t) => PUBLICATION_TYPE_LABEL[t]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {paper.citationCount !== null && (
        <Badge title={`${paper.citationCount} citations`}>
          <Quote aria-hidden />
          {formatCount(paper.citationCount)} citations
        </Badge>
      )}
      {(paper.isOpenAccess || paper.openAccessPdfUrl) && (
        <Badge tone="success">
          <LockOpen aria-hidden />
          Open access
        </Badge>
      )}
      {type && <Badge tone="outline">{PUBLICATION_TYPE_LABEL[type]}</Badge>}
      {paper.isUserPaper && <Badge tone="outline">Entered manually</Badge>}
    </div>
  );
}

/** Compact paper card used in search results, citation lists and collections. */
export function PaperCard({
  paper,
  actions,
  footer,
  dense,
  highlight,
}: {
  paper: PaperSummary;
  actions?: ReactNode;
  footer?: ReactNode;
  dense?: boolean;
  highlight?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const abstract = paper.abstract;
  return (
    <article
      className={cn(
        "group rounded-xl border border-border bg-surface shadow-xs transition-colors hover:border-border-strong",
        dense ? "p-3" : "p-4",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h3 className={cn("font-serif leading-snug font-semibold", dense ? "text-[15px]" : "text-[17px]")}>
            <Link href={`/papers/${paper.id}`} className="underline-offset-2 hover:text-accent-text hover:underline">
              {paper.title}
            </Link>
          </h3>
          <PaperMeta paper={paper} className="mt-1" />
          {highlight}
          {!dense && abstract && (
            <div className="mt-2 text-[13.5px] leading-relaxed text-text/85">
              <p className={cn(!expanded && "line-clamp-3")}>{abstract}</p>
              {abstract.length > 280 && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="mt-0.5 text-[13px] font-medium text-accent-text hover:underline"
                  aria-expanded={expanded}
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}
          {!dense && !abstract && (
            <p className="mt-2 text-[13px] text-subtle italic">No abstract available from the source.</p>
          )}
          <div className="mt-2.5">
            <PaperBadges paper={paper} />
          </div>
          {footer}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">{actions}</div>
        )}
      </div>
    </article>
  );
}

export function ExternalIdLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-accent-text hover:underline"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}
