"use client";

import { BookOpenText, ExternalLink, FileUp, Link2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import type { PaperDetail } from "@/lib/types";

/**
 * Shown when a paper has no PDF in the workspace. Only legally accessible sources are offered:
 * the known open-access copy, the user's own file, or a URL they are permitted to use.
 */
export function NoPdf({ paper, onAttached }: { paper: PaperDetail; onAttached: (fileId: string) => void }) {
  const [busy, setBusy] = useState<"oa" | "url" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const run = async (kind: "oa" | "url" | "upload", fn: () => Promise<{ id: string }>) => {
    setBusy(kind);
    setError(null);
    try {
      const file = await fn();
      onAttached(file.id);
    } catch (err) {
      setError(errorMessage(err, "The PDF could not be added."));
    } finally {
      setBusy(null);
    }
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") {
      setError("Please choose a PDF file.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    void run("upload", () => api<{ id: string }>(`/api/papers/${paper.id}/files`, { body: form }));
  };

  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <div className="rounded-xl border border-border bg-surface p-6 shadow-xs">
        <h2 className="text-base font-semibold">No PDF for this paper yet</h2>
        <p className="mt-1 text-sm text-muted">
          Add a PDF to read, highlight and annotate it here. Only use copies you are allowed to access: open-access
          versions, your own files, or links you are permitted to use.
        </p>

        {!paper.pdfAvailable && paper.freeReadUrl && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-muted">
            It is free to read at{" "}
            <a
              href={paper.freeReadUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent-text underline"
            >
              {new URL(paper.freeReadUrl).hostname}
              <ExternalLink className="ml-0.5 inline size-3" aria-hidden />
            </a>
            , without a downloadable PDF here. Download it there if the site allows, then upload it below.
          </p>
        )}

        <div className="mt-5 space-y-4">
          {paper.pdfAvailable && (
            <div>
              <Button
                variant="primary"
                className="w-full justify-center"
                loading={busy === "oa"}
                disabled={!!busy}
                onClick={() => run("oa", () => api<{ id: string }>(`/api/papers/${paper.id}/files`, { body: {} }))}
              >
                <BookOpenText />
                Read the free PDF
              </Button>
              <p
                className="mt-1 truncate text-center text-[12px] text-subtle"
                title={paper.openAccessPdfUrl ?? undefined}
              >
                {paper.ids.arxiv
                  ? "Read live from arxiv.org: always the newest version, nothing stored"
                  : paper.openAccessPdfUrl
                    ? `Read live from ${new URL(paper.openAccessPdfUrl).hostname}: always its current version`
                    : "From OpenReview (a copy is kept here)"}
              </p>
            </div>
          )}

          <div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              aria-label="Choose a PDF file"
              onChange={(e) => {
                upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              variant={paper.pdfAvailable ? "secondary" : "primary"}
              className="w-full justify-center"
              loading={busy === "upload"}
              disabled={!!busy}
              onClick={() => inputRef.current?.click()}
            >
              <FileUp />
              Upload PDF
            </Button>
          </div>

          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim())
                void run("url", () =>
                  api<{ id: string }>(`/api/papers/${paper.id}/files`, { body: { url: url.trim() } }),
                );
            }}
          >
            <label htmlFor="pdf-url" className="text-[13px] font-medium">
              Add PDF from a URL
            </label>
            <div className="flex gap-2">
              <Input
                id="pdf-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/paper.pdf"
              />
              <Button type="submit" loading={busy === "url"} disabled={!!busy || !url.trim()}>
                <Link2 />
                Add
              </Button>
            </div>
          </form>

          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
