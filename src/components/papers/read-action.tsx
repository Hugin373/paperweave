"use client";

import { BookOpenText, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { identifierUrl } from "@/lib/identifiers";
import { useInvalidateLibrary } from "@/lib/mutations";
import type { IdentifierMap } from "@/lib/types";

/** Where to read a paper that has no PDF here: its publisher (DOI), PubMed, OpenReview or arXiv page. */
export function sourcePageUrl(ids: IdentifierMap): string | null {
  for (const kind of ["doi", "pmcid", "pmid", "openreview", "arxiv"] as const) {
    const value = ids[kind];
    if (value) return identifierUrl(kind, value);
  }
  return null;
}

/**
 * The paper's PDF action:
 * - "Read" when it has a PDF here, or a free, legal copy is known to exist (`pdfAvailable`): the free
 *   copy is added as a live PDF (read from its source, always the newest version), then opened;
 * - "Read free" when it is free to read online without a downloadable PDF (e.g. PubMed Central);
 * - otherwise, with `sourceFallback`, a "Source" link to read it on the publisher's or index's site.
 */
export function ReadAction({
  paperId,
  hasFile,
  pdfAvailable,
  freeReadUrl = null,
  pdfUrl = null,
  ids,
  sourceFallback = false,
  size = "sm",
  variant = "secondary",
}: {
  paperId: string;
  hasFile: boolean;
  pdfAvailable: boolean;
  freeReadUrl?: string | null;
  /** The free PDF's link: opened in the browser when the server is refused (some publishers block it). */
  pdfUrl?: string | null;
  ids?: IdentifierMap;
  sourceFallback?: boolean;
  size?: "sm" | "md";
  variant?: "secondary" | "primary";
}) {
  const router = useRouter();
  const invalidate = useInvalidateLibrary();
  const [loading, setLoading] = useState(false);

  if (!hasFile && !pdfAvailable && freeReadUrl) {
    return (
      <Button size={size} variant="secondary" asChild>
        <a
          href={freeReadUrl}
          target="_blank"
          rel="noreferrer"
          title={`Free to read at ${new URL(freeReadUrl).hostname} (no downloadable PDF)`}
        >
          <ExternalLink />
          Read free
        </a>
      </Button>
    );
  }
  if (!hasFile && !pdfAvailable) {
    const source = sourceFallback && ids ? sourcePageUrl(ids) : null;
    if (!source) return null;
    return (
      <Button size={size} variant="ghost" asChild>
        <a href={source} target="_blank" rel="noreferrer" title="No free PDF is known. Read it on the source site.">
          <ExternalLink />
          Source
        </a>
      </Button>
    );
  }

  const open = async () => {
    if (hasFile) return router.push(`/papers/${paperId}/read`);
    setLoading(true);
    try {
      const file = await api<{ id: string }>(`/api/papers/${paperId}/files`, { body: {} });
      await invalidate();
      router.push(`/papers/${paperId}/read?file=${file.id}`);
    } catch (err) {
      // Some publishers refuse automated downloads but serve the same PDF to a browser.
      toast.error(errorMessage(err, "The free PDF could not be opened. You can upload one instead."), {
        ...(pdfUrl
          ? {
              description: "The publisher may still show it in your browser.",
              action: { label: "Open in browser", onClick: () => window.open(pdfUrl, "_blank", "noopener") },
              duration: 12_000,
            }
          : {}),
      });
      setLoading(false);
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      onClick={open}
      loading={loading}
      title={
        hasFile
          ? "Open the PDF in the reader"
          : "Open the free, legal PDF in the reader. It is read from its source, so it is always the newest version."
      }
    >
      <BookOpenText />
      Read
    </Button>
  );
}
