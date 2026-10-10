"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, GitFork, Lightbulb, Network, NotebookPen, Plus, RefreshCw, Telescope } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ConceptPicker } from "@/components/concepts/concept-picker";
import { CollectionPicker, TagChip, TagPicker } from "@/components/library/organize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/api";
import { formatCount, PUBLICATION_TYPE_LABEL, relativeTime } from "@/lib/format";
import { useAiEnabled } from "@/lib/hooks";
import { identifierLabel, identifierUrl } from "@/lib/identifiers";
import type { NoteSummary, PaperDetail } from "@/lib/types";
import { CitationList } from "./citation-list";
import { ConceptSuggestions } from "./concept-suggestions";
import { ExternalIdLink, PaperBadges } from "./paper-card";
import { PaperAiPanel } from "./paper-ai-panel";
import { ArxivLink } from "./arxiv-link";
import { AddPdfUrlDialog, PaperFiles, UploadPdfButton } from "./paper-files";
import { OpenReviewPanel } from "./openreview-panel";
import { ReadAction } from "./read-action";
import { SaveControl } from "./save-control";

const ID_ORDER = ["doi", "arxiv", "s2", "openalex", "pmid", "pmcid", "openreview"] as const;
const SOURCE_NAME: Record<string, string> = {
  semantic_scholar: "Semantic Scholar",
  openalex: "OpenAlex",
  crossref: "Crossref",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
  openreview: "OpenReview",
  user: "manual entry",
};

function NoteList({ notes, empty }: { notes: NoteSummary[]; empty: string }) {
  if (!notes.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li key={n.id}>
          <Link
            href={`/notes/${n.id}`}
            className="block rounded-lg border border-border bg-surface px-3 py-2 hover:border-border-strong"
          >
            <span className="text-sm font-medium">{n.title}</span>
            {n.excerpt && <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{n.excerpt}</span>}
            <span className="mt-1 block text-[11.5px] text-subtle">Edited {relativeTime(n.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Authors({ paper }: { paper: PaperDetail }) {
  const [all, setAll] = useState(false);
  const list = paper.authorDetails;
  const shown = all ? list : list.slice(0, 8);
  if (!list.length) return <p className="text-sm text-muted">Authors unknown</p>;
  return (
    <p className="text-[14.5px] leading-relaxed">
      {shown.map((a, i) => (
        <span key={`${a.name}-${i}`}>
          <Link
            href={`/search?q=${encodeURIComponent(a.name)}&mode=author`}
            className="hover:text-accent-text hover:underline"
            title={`Search papers by ${a.name}`}
          >
            {a.name}
          </Link>
          {i < shown.length - 1 && ", "}
        </span>
      ))}
      {list.length > 8 && (
        <button
          type="button"
          className="ml-1 text-sm text-accent-text hover:underline"
          onClick={() => setAll((x) => !x)}
        >
          {all ? "show fewer" : `+${list.length - 8} more`}
        </button>
      )}
    </p>
  );
}

function CopyBibtex({ paperId, inLibrary }: { paperId: string; inLibrary: boolean }) {
  if (!inLibrary) return null;
  const copy = async () => {
    try {
      const res = await fetch(`/api/export?format=bibtex&paperIds=${paperId}`);
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text());
      toast.success("BibTeX copied to clipboard");
    } catch {
      toast.error("Could not copy BibTeX.");
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={copy}>
      <Copy />
      Copy BibTeX
    </Button>
  );
}

export function PaperView({ id }: { id: string }) {
  const qc = useQueryClient();
  const aiEnabled = useAiEnabled();
  const [tab, setTab] = useState("overview");
  const {
    data: paper,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["paper", id],
    queryFn: () => api<PaperDetail>(`/api/papers/${id}`),
  });
  const refresh = useMutation({
    mutationFn: () => api<{ updated: boolean }>(`/api/papers/${id}/refresh`, { body: {} }),
    onSuccess: (r) => {
      toast.success(r.updated ? "Metadata refreshed from scholarly sources" : "No newer metadata was available");
      return qc.invalidateQueries({ queryKey: ["paper", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-4/5" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error || !paper) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState title="This paper could not be loaded" error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const inLibrary = !!paper.library;
  const hasPdfText = paper.files.some((f) => f.textStatus === "ready");
  const ids = ID_ORDER.filter((k) => paper.ids[k]);
  const type = paper.publicationTypes.find((t) => PUBLICATION_TYPE_LABEL[t]);

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/search"
        onClick={(e) => {
          if (history.length > 1) {
            e.preventDefault();
            history.back();
          }
        }}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back
      </Link>

      <header className="space-y-3">
        <h1 className="font-serif text-[26px] leading-tight font-semibold tracking-tight md:text-3xl">{paper.title}</h1>
        <Authors paper={paper} />
        <p className="text-sm text-muted">
          {[paper.venue, paper.publicationDate ?? paper.year, type ? PUBLICATION_TYPE_LABEL[type] : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <PaperBadges paper={paper} />
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-y border-border py-3">
        <SaveControl paperId={paper.id} library={paper.library} size="md" />
        <ReadAction
          paperId={paper.id}
          hasFile={paper.files.length > 0}
          pdfAvailable={paper.pdfAvailable}
          freeReadUrl={paper.freeReadUrl}
          pdfUrl={paper.openAccessPdfUrl}
          size="md"
          variant="primary"
        />
        {!paper.files.length && <UploadPdfButton paperId={paper.id} size="md" />}
        <Button variant="secondary" asChild>
          <Link href={paper.files.length ? `/papers/${paper.id}/read?panel=notes` : `/notes/new?paperId=${paper.id}`}>
            <NotebookPen />
            Add note
          </Link>
        </Button>
        <ConceptPicker
          paperId={paper.id}
          linked={paper.concepts}
          trigger={
            <Button variant="secondary">
              <Lightbulb />
              Link concept
            </Button>
          }
        />
        <Button variant="secondary" asChild>
          <Link href={`/papers/${paper.id}/graph`}>
            <GitFork />
            Citation graph
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link href={`/graph?focus=paper:${paper.id}`}>
            <Network />
            In my graph
          </Link>
        </Button>
        <Button variant="ai" asChild>
          <Link href={`/research?papers=${paper.id}`}>
            <Telescope />
            Ask AI
          </Link>
        </Button>
      </div>

      {inLibrary && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {paper.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
          <TagPicker paperIds={[paper.id]} current={paper.tags} />
          {paper.collections.map((c) => (
            <Link key={c.id} href={`/library?collection=${c.id}`}>
              <Badge tone="accent" className="hover:brightness-95">
                <span className="size-1.5 rounded-full" style={{ background: c.color ?? "currentColor" }} aria-hidden />
                {c.name}
              </Badge>
            </Link>
          ))}
          <CollectionPicker paperIds={[paper.id]} current={paper.collections} />
          <CopyBibtex paperId={paper.id} inLibrary={inLibrary} />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="references">
            References
            {paper.referenceCount !== null && <span className="text-subtle">{formatCount(paper.referenceCount)}</span>}
          </TabsTrigger>
          <TabsTrigger value="citations">
            Cited by
            {paper.citationCount !== null && <span className="text-subtle">{formatCount(paper.citationCount)}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-8">
              <section aria-labelledby="abstract-title">
                <h2 id="abstract-title" className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
                  Abstract
                </h2>
                {paper.abstract ? (
                  <p className="font-serif text-[16px] leading-relaxed whitespace-pre-line">{paper.abstract}</p>
                ) : (
                  <p className="text-sm text-muted italic">
                    The scholarly sources don’t provide an abstract for this paper.
                  </p>
                )}
              </section>

              <PaperAiPanel paperId={paper.id} hasPdfText={hasPdfText} />

              <section aria-labelledby="notes-title">
                <div className="mb-3 flex items-center justify-between">
                  <h2 id="notes-title" className="text-sm font-semibold tracking-wide text-muted uppercase">
                    Your notes
                  </h2>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/notes/new?paperId=${paper.id}`}>
                      <Plus />
                      New note
                    </Link>
                  </Button>
                </div>
                <NoteList notes={paper.notes} empty="No notes about this paper yet." />
                {paper.mentionedIn.length > 0 && (
                  <div className="mt-5">
                    <h3 className="mb-2 text-[13px] font-medium text-muted">Mentioned in other notes</h3>
                    <NoteList notes={paper.mentionedIn} empty="" />
                  </div>
                )}
              </section>

              <section aria-labelledby="pdf-title">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 id="pdf-title" className="text-sm font-semibold tracking-wide text-muted uppercase">
                    PDF
                  </h2>
                  <div className="flex gap-1">
                    {paper.files.length > 0 && <UploadPdfButton paperId={paper.id} />}
                    <AddPdfUrlDialog paperId={paper.id} />
                  </div>
                </div>
                {paper.files.length ? (
                  <PaperFiles paperId={paper.id} files={paper.files} />
                ) : (
                  <p className="text-sm text-muted">
                    {paper.pdfAvailable
                      ? "A free, legal PDF is available. “Read” opens it here, read live from its source (always the newest version)."
                      : paper.freeReadUrl
                        ? `Free to read at ${new URL(paper.freeReadUrl).hostname}, but no downloadable PDF is offered. Download it there if the site allows, then upload it here to read and annotate it.`
                        : "No free, legal PDF is known. Upload your own copy to read and annotate it."}
                  </p>
                )}
                {paper.metadataSource === "openreview" && !paper.ids.arxiv && <ArxivLink paperId={paper.id} />}
                {paper.highlightCount > 0 && (
                  <p className="mt-2 text-[13px] text-muted">
                    {paper.highlightCount} highlight{paper.highlightCount > 1 ? "s" : ""} and annotations.
                  </p>
                )}
              </section>
            </div>

            <aside className="space-y-6">
              <section aria-labelledby="concepts-title">
                <div className="mb-2 flex items-center justify-between">
                  <h2 id="concepts-title" className="text-sm font-semibold tracking-wide text-muted uppercase">
                    Concepts
                  </h2>
                  <ConceptPicker
                    paperId={paper.id}
                    linked={paper.concepts}
                    trigger={
                      <Button size="icon-sm" variant="ghost" aria-label="Link concept">
                        <Plus />
                      </Button>
                    }
                  />
                </div>
                {paper.concepts.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {paper.concepts.map((c) => (
                      <Link key={c.id} href={`/concepts/${c.id}`} className="mention" data-type="concept">
                        {c.name}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted">
                    Link ideas like “metric depth” to connect this paper to your knowledge.
                  </p>
                )}
                {aiEnabled && (
                  <div className="mt-3">
                    <ConceptSuggestions paperId={paper.id} linkedIds={paper.concepts.map((c) => c.id)} />
                  </div>
                )}
              </section>

              {!paper.isUserPaper && <OpenReviewPanel paperId={paper.id} />}

              <section aria-labelledby="ids-title">
                <h2 id="ids-title" className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
                  Identifiers
                </h2>
                <dl className="space-y-1.5 text-[13px]">
                  {ids.map((k) => {
                    const url = identifierUrl(k, paper.ids[k]!);
                    return (
                      <div key={k} className="flex gap-2">
                        <dt className="w-28 shrink-0 text-muted">{identifierLabel(k)}</dt>
                        <dd className="min-w-0 truncate">
                          {url ? <ExternalIdLink href={url}>{paper.ids[k]}</ExternalIdLink> : paper.ids[k]}
                        </dd>
                      </div>
                    );
                  })}
                  {paper.url && !ids.length && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-muted">Link</dt>
                      <dd className="min-w-0 truncate">
                        <ExternalIdLink href={paper.url}>Publisher page</ExternalIdLink>
                      </dd>
                    </div>
                  )}
                </dl>
              </section>

              <section aria-labelledby="facts-title" className="text-[13px]">
                <h2 id="facts-title" className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
                  Details
                </h2>
                <dl className="space-y-1.5">
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">Citations</dt>
                    <dd>{paper.citationCount?.toLocaleString() ?? "Unknown"}</dd>
                  </div>
                  {paper.influentialCitationCount !== null && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-muted">Influential</dt>
                      <dd>{paper.influentialCitationCount.toLocaleString()}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">References</dt>
                    <dd>{paper.referenceCount?.toLocaleString() ?? "Unknown"}</dd>
                  </div>
                  {paper.fieldsOfStudy.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-muted">Fields</dt>
                      <dd>{paper.fieldsOfStudy.join(", ")}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted">Open access</dt>
                    <dd>{paper.isOpenAccess === null ? "Unknown" : paper.isOpenAccess ? "Yes" : "No"}</dd>
                  </div>
                </dl>
                <p className="mt-3 flex items-center gap-1.5 text-[12px] text-subtle">
                  Metadata from {SOURCE_NAME[paper.metadataSource] ?? paper.metadataSource}
                  {paper.metadataRefreshedAt && `, refreshed ${relativeTime(paper.metadataRefreshedAt)}`}
                  {!paper.isUserPaper && (
                    <button
                      type="button"
                      onClick={() => refresh.mutate()}
                      disabled={refresh.isPending}
                      className="rounded p-0.5 hover:bg-surface-2 hover:text-text"
                      aria-label="Refresh metadata"
                    >
                      <RefreshCw className={`size-3 ${refresh.isPending ? "animate-spin" : ""}`} />
                    </button>
                  )}
                </p>
              </section>
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="references" className="pt-6">
          <CitationList paperId={paper.id} direction="references" />
        </TabsContent>
        <TabsContent value="citations" className="pt-6">
          <CitationList paperId={paper.id} direction="citations" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
