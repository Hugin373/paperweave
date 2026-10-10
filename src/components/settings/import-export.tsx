"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileJson, FileText, FileUp, ListPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { useCollections } from "@/lib/hooks";
import { useInvalidateLibrary } from "@/lib/mutations";
import type { JobDto } from "@/lib/types";

interface ImportResult {
  total: number;
  processed: number;
  matched: number;
  created: number;
  failed: { label: string; reason: string }[];
}

function JobProgress({ jobId, onDone }: { jobId: number; onDone: () => void }) {
  const { data } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<JobDto>(`/api/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && ["succeeded", "failed"].includes(q.state.data.status) ? false : 1500),
  });
  const done = data?.status === "succeeded" || data?.status === "failed";
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);
  const r = data?.result as ImportResult | null | undefined;
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3 text-sm" role="status" aria-live="polite">
      {!done && (
        <p className="flex items-center gap-2">
          <Spinner />
          Importing… {r ? `${r.processed}/${r.total}` : "queued"}
        </p>
      )}
      {data?.status === "failed" && <p className="text-danger">The import failed: {data.lastError}</p>}
      {data?.status === "succeeded" && r && (
        <div>
          <p className="font-medium text-success">
            Import finished: {r.matched} matched in scholarly sources, {r.created} added as manual entries,{" "}
            {r.failed.length} failed.
          </p>
          {r.failed.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted">Show entries that failed</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-muted">
                {r.failed.map((f, i) => (
                  <li key={i}>
                    {f.label} — {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function ImportPanel() {
  const { data: collections } = useCollections();
  const invalidate = useInvalidateLibrary();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [collectionId, setCollectionId] = useState("");
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);

  const onDone = () => {
    void invalidate();
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };

  const importBib = async (file: File) => {
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    if (collectionId) form.append("collectionId", collectionId);
    try {
      const res = await api<{ jobId: number; total: number }>("/api/import/bibtex", { body: form });
      setJobId(res.jobId);
      toast.success(`Importing ${res.total} entries`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const importIds = async () => {
    setBusy(true);
    try {
      const res = await api<{ jobId: number; total: number }>("/api/import/identifiers", {
        body: { text: ids, collectionId: collectionId || null },
      });
      setJobId(res.jobId);
      setIds("");
      toast.success(`Importing ${res.total} identifiers`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <Field
        label="Add imported papers to a collection"
        htmlFor="import-collection"
        hint="Optional. Papers are always added to your library."
      >
        <Select id="import-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
          <option value="">No collection</option>
          {collections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <section className="rounded-xl border border-border bg-surface p-5">
        <h3 className="flex items-center gap-2 font-medium">
          <FileUp className="size-4" aria-hidden />
          BibTeX file
        </h3>
        <p className="mt-1 text-sm text-muted">
          Works with exports from Zotero, Mendeley, JabRef and Google Scholar. Entries are matched by DOI, arXiv id or
          exact title; anything not found is added as a manual entry so nothing is lost.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".bib,.bibtex,text/plain,application/x-bibtex"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => e.target.files?.[0] && importBib(e.target.files[0])}
        />
        <Button className="mt-3" onClick={() => fileRef.current?.click()} loading={busy}>
          Choose .bib file
        </Button>
      </section>
      <section className="rounded-xl border border-border bg-surface p-5">
        <h3 className="flex items-center gap-2 font-medium">
          <ListPlus className="size-4" aria-hidden />
          DOIs, arXiv links and other identifiers
        </h3>
        <Field label="One per line" htmlFor="import-ids" className="mt-3">
          <Textarea
            id="import-ids"
            rows={6}
            value={ids}
            onChange={(e) => setIds(e.target.value)}
            placeholder={"10.1038/nature14539\nhttps://arxiv.org/abs/1706.03762\nPMID:26017442"}
            className="font-mono text-[13px]"
          />
        </Field>
        <Button className="mt-3" variant="primary" onClick={importIds} disabled={!ids.trim()} loading={busy}>
          Import identifiers
        </Button>
      </section>
      {jobId !== null && <JobProgress key={jobId} jobId={jobId} onDone={onDone} />}
    </div>
  );
}

const EXPORTS = [
  {
    format: "json",
    icon: FileJson,
    title: "Complete export (JSON)",
    description:
      "Everything with stable identifiers and relationships: papers, collections, tags, concepts, notes (Markdown and structured), highlights and citations.",
  },
  {
    format: "markdown",
    icon: FileText,
    title: "Markdown archive (.zip)",
    description:
      "Notes, concepts and paper cards as Markdown files with [[wiki-links]] — opens directly as an Obsidian vault.",
  },
  {
    format: "bibtex",
    icon: Download,
    title: "BibTeX",
    description: "References for every paper in your library, for LaTeX and reference managers.",
  },
] as const;

export function ExportPanel() {
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted">Your knowledge is yours. Export it in open formats at any time.</p>
      {EXPORTS.map(({ format, icon: Icon, title, description }) => (
        <div key={format} className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface p-4">
          <Icon className="size-5 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{title}</p>
            <p className="text-sm text-muted">{description}</p>
          </div>
          <Button asChild>
            <a href={`/api/export?format=${format}`} download>
              <Download />
              Download
            </a>
          </Button>
        </div>
      ))}
    </div>
  );
}
