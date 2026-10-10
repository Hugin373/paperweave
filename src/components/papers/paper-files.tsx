"use client";

import { FileText, Link2, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, relativeTime } from "@/lib/format";
import { useInvalidateLibrary } from "@/lib/mutations";
import type { PaperFileInfo } from "@/lib/types";

const SOURCE_LABEL = { upload: "Uploaded", open_access: "Open access", external_url: "From URL" } as const;
const TEXT_LABEL = {
  pending: "Text extraction queued",
  processing: "Extracting text…",
  ready: "Full text searchable",
  failed: "Text could not be extracted (reading still works)",
} as const;

export function UploadPdfButton({ paperId, size = "sm" }: { paperId: string; size?: "sm" | "md" }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const invalidate = useInvalidateLibrary();
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    if (file.type && file.type !== "application/pdf") {
      toast.error("Please choose a PDF file.");
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api<{ id: string }>(`/api/papers/${paperId}/files`, { body: form });
      await invalidate();
      toast.success("PDF uploaded");
      router.push(`/papers/${paperId}/read?file=${res.id}`);
    } catch (err) {
      toast.error(errorMessage(err, "The upload failed."));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      <Button size={size} variant="secondary" loading={busy} onClick={() => input.current?.click()}>
        <Upload />
        Upload PDF
      </Button>
    </>
  );
}

export function AddPdfUrlDialog({ paperId }: { paperId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateLibrary();
  const router = useRouter();
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<{ id: string }>(`/api/papers/${paperId}/files`, { body: { url } });
      await invalidate();
      setOpen(false);
      router.push(`/papers/${paperId}/read?file=${res.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Link2 />
        PDF from URL
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Add a PDF from a URL"
          description="Use a link you are permitted to access, such as a preprint server or an institutional repository. The file is stored privately in your workspace."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (url) submit();
            }}
            className="space-y-4"
          >
            <Field label="PDF URL" htmlFor="pdf-url">
              <Input
                id="pdf-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/paper.pdf"
                required
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Add PDF
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function PaperFiles({ paperId, files }: { paperId: string; files: PaperFileInfo[] }) {
  const invalidate = useInvalidateLibrary();
  const remove = async (f: PaperFileInfo) => {
    if (!confirm(`Delete “${f.filename}”? Highlights made on this PDF will be deleted too.`)) return;
    try {
      await api(`/api/files/${f.id}`, { method: "DELETE" });
      await invalidate();
      toast.success("PDF deleted");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (!files.length) return null;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <FileText className="size-4 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <Link
              href={`/papers/${paperId}/read?file=${f.id}`}
              className="block truncate text-sm font-medium hover:text-accent-text hover:underline"
            >
              {f.filename}
            </Link>
            <p className="text-[12px] text-muted">
              {f.live
                ? `Live from ${f.sourceUrl ? new URL(f.sourceUrl).hostname : "its source"}${f.version ? ` · ${f.version}` : ""} · not stored`
                : `${SOURCE_LABEL[f.source]}${f.version ? ` · ${f.version}` : ""} · ${formatBytes(f.sizeBytes)}`}
              {f.pageCount ? ` · ${f.pageCount} pages` : ""} · {relativeTime(f.createdAt)} · {TEXT_LABEL[f.textStatus]}
            </p>
          </div>
          <Button size="icon-sm" variant="danger-ghost" onClick={() => remove(f)} aria-label={`Delete ${f.filename}`}>
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}
