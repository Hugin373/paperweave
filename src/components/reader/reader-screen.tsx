"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  Ellipsis,
  HardDriveDownload,
  History,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip,
} from "@/components/ui/menu";
import { ErrorState } from "@/components/ui/states";
import { PageLoading } from "@/components/ui/spinner";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useAiEnabled } from "@/lib/hooks";
import type { HighlightDto, PaperDetail, PaperFileInfo } from "@/lib/types";
import { NoPdf } from "./no-pdf";
import type { JumpRequest } from "./pdf-viewer";
import type { ReaderAiRequest } from "./reader-assistant";
import { ReaderSidebar, type SidebarTab } from "./reader-sidebar";
import { ReaderGraphDock } from "./reader-graph-dock";
import type { QuoteRequest } from "./reader-notes";
import { useHighlights, type NewHighlight } from "./use-highlights";
import { usePersistentState } from "@/lib/use-persistent-state";

const NO_HIGHLIGHTS: HighlightDto[] = [];

// pdf.js needs browser APIs, so the viewer is never rendered on the server.
const PdfViewer = dynamic(() => import("./pdf-viewer"), {
  ssr: false,
  loading: () => <PageLoading label="Loading reader…" />,
});

function TextStatus({ file }: { file: PaperFileInfo }) {
  switch (file.textStatus) {
    case "ready":
      return (
        <Badge tone="success" title="The text of this PDF is searchable and available as AI context">
          Text indexed
        </Badge>
      );
    case "failed":
      return (
        <Badge
          tone="warning"
          title="Reading and highlighting still work; workspace search and AI only see the abstract"
        >
          Text not extracted
        </Badge>
      );
    default:
      return <Badge title="Text is being extracted for search and AI context">Extracting text…</Badge>;
  }
}

const hostOf = (url: string | null) => (url ? new URL(url).hostname.replace(/^www\./, "") : null);

/** Live or stored, and which version: shown next to the title. */
function SourceBadge({ file }: { file: PaperFileInfo }) {
  if (file.live) {
    return (
      <Badge
        tone="accent"
        title={`Read from ${hostOf(file.sourceUrl)} each time, so it is always the newest version. Nothing is stored here.`}
      >
        <Radio className="size-3" aria-hidden />
        Live{file.version ? ` · ${file.version}` : ""}
      </Badge>
    );
  }
  return (
    <Badge title={file.canSwitch ? "A copy is kept here; it still moves to newer versions" : "Stored here"}>
      {file.canSwitch ? "Saved copy" : "Uploaded"}
      {file.version ? ` · ${file.version}` : ""}
    </Badge>
  );
}

/** Shown once after the PDF moved to a newer version. */
function VersionNoticeBar({ file, onDismiss }: { file: PaperFileInfo; onDismiss: () => void }) {
  const n = file.versionNotice;
  if (!n) return null;
  const what =
    n.to && n.from
      ? `Updated to ${n.to} (you last read ${n.from}).`
      : n.to
        ? `Updated to ${n.to}, the newest version.`
        : `This PDF changed at ${hostOf(file.sourceUrl) ?? "its source"} since you last read it; this is the new version.`;
  const total = n.moved + n.lost;
  const highlights = !total
    ? ""
    : n.lost
      ? ` ${n.moved} of ${total} highlights moved with it; ${n.lost} could not be found (see the end of the Highlights list).`
      : ` All ${total} highlights moved with it.`;
  return (
    <div
      role="status"
      className="flex shrink-0 animate-fade-in items-start gap-2 border-b border-border bg-accent-soft px-3 py-2 text-[13px]"
    >
      <RefreshCw className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        {what}
        {highlights}
      </p>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Got it
      </Button>
    </div>
  );
}

export function ReaderScreen({
  paperId,
  initialFileId,
  initialPage,
  highlightId,
  initialTab = "highlights",
}: {
  paperId: string;
  initialFileId: string | null;
  initialPage: number | null;
  highlightId: string | null;
  initialTab?: SidebarTab;
}) {
  const qc = useQueryClient();
  const aiEnabled = useAiEnabled();
  const paperQuery = useQuery({
    queryKey: ["paper", paperId],
    queryFn: () => api<PaperDetail>(`/api/papers/${paperId}`),
    // Poll while text extraction is running so the status badge updates.
    refetchInterval: (q) =>
      q.state.data?.files.some((f) => f.textStatus === "pending" || f.textStatus === "processing") ? 4000 : false,
  });
  const paper = paperQuery.data;

  const [chosenFileId, setChosenFileId] = useState<string | null>(initialFileId);
  const files = paper?.files ?? [];
  const file = files.find((f) => f.id === chosenFileId) ?? files[0] ?? null;
  const fileId = file?.id ?? null;

  const { highlights, create, update, remove } = useHighlights(fileId);
  const placedHighlights = useMemo(() => highlights.filter((h) => !h.lost), [highlights]);
  // An older arXiv version opened for reference (read-only), or null for the current one.
  const [olderVersion, setOlderVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState<"check" | "switch" | null>(null);

  const refreshFile = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["paper", paperId] });
    void qc.invalidateQueries({ queryKey: ["highlights", fileId] });
  }, [qc, paperId, fileId]);

  // Opening a free PDF checks its source for a newer version in the background (the server trusts a
  // recent check, so this is usually instant).
  const checkedFile = useRef<string | null>(null);
  useEffect(() => {
    if (!file?.canSwitch || checkedFile.current === file.id) return;
    checkedFile.current = file.id;
    api<{ updated: boolean }>(`/api/files/${file.id}/check`, { body: { force: false } })
      .then((r) => (r.updated ? refreshFile() : undefined))
      .catch(() => {});
  }, [file, refreshFile]);

  const checkNow = async () => {
    if (!file) return;
    setBusy("check");
    try {
      const r = await api<{ updated: boolean; file: PaperFileInfo }>(`/api/files/${file.id}/check`, {
        body: { force: true },
      });
      if (r.updated) {
        setOlderVersion(null);
        await refreshFile();
      } else {
        toast.success(`This is the newest version${r.file.version ? ` (${r.file.version})` : ""}.`);
      }
    } catch (err) {
      toast.error(errorMessage(err, "The source could not be checked. Try again later."));
    } finally {
      setBusy(null);
    }
  };

  const switchLive = async (live: boolean) => {
    if (!file) return;
    setBusy("switch");
    try {
      await api(`/api/files/${file.id}`, { method: "PATCH", body: { live } });
      await refreshFile();
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast.success(
        live
          ? `Reading live from ${hostOf(file.sourceUrl)}. The saved copy was removed (${formatBytes(file.sizeBytes)} freed).`
          : "A copy is kept here for offline reading. It still moves to newer versions.",
      );
    } catch (err) {
      toast.error(errorMessage(err, "That did not work. Try again later."));
    } finally {
      setBusy(null);
    }
  };

  const dismissNotice = async () => {
    if (!file) return;
    qc.setQueryData<PaperDetail>(["paper", paperId], (p) =>
      p ? { ...p, files: p.files.map((f) => (f.id === file.id ? { ...f, versionNotice: null } : f)) } : p,
    );
    await api(`/api/files/${file.id}`, { method: "PATCH", body: { dismissNotice: true } }).catch(() => {});
  };

  const currentVersion = Number(/^v(\d+)$/.exec(file?.version ?? "")?.[1] ?? 0);
  const viewUrl =
    file && olderVersion && file.arxivId ? `https://arxiv.org/pdf/${file.arxivId}v${olderVersion}` : file?.viewUrl;

  const [selectedId, setSelectedId] = useState<string | null>(highlightId);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [jump, setJump] = useState<JumpRequest | null>(initialPage ? { page: initialPage, nonce: 1 } : null);
  const [tab, setTab] = useState<SidebarTab>(initialTab);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiRequest, setAiRequest] = useState<ReaderAiRequest | null>(null);
  const [page, setPage] = useState<number | null>(initialPage);
  const [quote, setQuote] = useState<QuoteRequest | null>(null);
  // Sidebar width (desktop): draggable and remembered.
  const [storedWidth, setStoredWidth] = usePersistentState<string>("pw-reader-sidebar-width", "420");
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const sidebarWidth = dragWidth ?? (Number(storedWidth) || 420);

  // Collapse the sidebar by default on small screens (deferred: it reacts to the browser, not to render).
  useEffect(() => {
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const t = setTimeout(() => setSidebarOpen(false));
    return () => clearTimeout(t);
  }, []);

  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 2200);
  }, []);

  const jumpTo = useCallback(
    (h: HighlightDto) => {
      setSelectedId(h.id);
      setJump({ page: h.pageNumber, y: h.rects[0]?.y ?? 0, nonce: Date.now() });
      flash(h.id);
    },
    [flash],
  );

  // Deep link: ?highlight=<id> scrolls to and flashes that highlight once it is loaded.
  const handledDeepLink = useRef(false);
  useEffect(() => {
    if (handledDeepLink.current || !highlightId || !highlights.length) return;
    const h = highlights.find((x) => x.id === highlightId);
    if (!h) return;
    // Deferred so the jump runs after the highlights have rendered.
    const t = setTimeout(() => {
      handledDeepLink.current = true;
      jumpTo(h);
    });
    return () => clearTimeout(t);
  }, [highlightId, highlights, jumpTo]);

  const onCreate = async (input: NewHighlight) => {
    try {
      return await create.mutateAsync(input);
    } catch {
      return undefined;
    }
  };

  // "Explain" / "Ask…" on a selection: handled by the assistant in the AI tab.
  const onAi = (req: { text: string; pageNumber: number; question?: string }) => {
    setSidebarOpen(true);
    setTab("ai");
    setAiRequest({ text: req.text, page: req.pageNumber, question: req.question, nonce: Date.now() });
  };
  const onPageChange = useCallback((p: number) => setPage(p), []);

  const onQuote = (req: { text: string; pageNumber: number }) => {
    setQuote({ ...req, nonce: Date.now() });
    setTab("notes");
    setSidebarOpen(true);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const right = aside.getBoundingClientRect().right;
    const clamp = (w: number) => Math.round(Math.min(Math.max(w, 300), Math.min(960, window.innerWidth * 0.7)));
    let latest = sidebarWidth;
    const move = (ev: PointerEvent) => {
      latest = clamp(right - ev.clientX);
      setDragWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setStoredWidth(String(latest));
      setDragWidth(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (paperQuery.isPending) return <PageLoading label="Loading paper…" />;
  if (paperQuery.isError || !paper) {
    return (
      <div className="p-6">
        <ErrorState
          title="This paper could not be loaded"
          error={paperQuery.error}
          onRetry={() => paperQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Tooltip content="Back to paper overview">
          <Button asChild size="icon" variant="ghost" aria-label="Back to paper overview">
            <Link href={`/papers/${paperId}`}>
              <ArrowLeft />
            </Link>
          </Button>
        </Tooltip>
        <Link
          href={`/papers/${paperId}`}
          className="min-w-0 flex-1 truncate font-serif text-[15px] font-semibold hover:underline"
        >
          {paper.title}
        </Link>
        {file && (
          <div className="flex shrink-0 items-center gap-2">
            {files.length > 1 && (
              <Select
                aria-label="PDF file"
                className="h-8 max-w-48 text-[13px]"
                value={file.id}
                onChange={(e) => {
                  setChosenFileId(e.target.value);
                  setSelectedId(null);
                }}
              >
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.filename}
                    {f.version ? ` ${f.version}` : ""} ({f.live ? "live" : formatBytes(f.sizeBytes)})
                  </option>
                ))}
              </Select>
            )}
            <span className="hidden items-center gap-1.5 sm:flex">
              <SourceBadge file={file} />
              <TextStatus file={file} />
            </span>
            <Tooltip content={olderVersion ? `Open v${olderVersion} on arXiv` : "Download PDF"}>
              <Button asChild size="icon" variant="ghost" aria-label="Download PDF">
                {/* Through this app, which marks it as a download: browsers do not download straight from
                    another site (arXiv), they open it. An older version only exists there. */}
                {olderVersion ? (
                  <a href={viewUrl} target="_blank" rel="noreferrer">
                    <Download />
                  </a>
                ) : (
                  <a href={`/api/files/${file.id}?download=1`} download={file.filename}>
                    <Download />
                  </a>
                )}
              </Button>
            </Tooltip>
            {file.canSwitch && (
              <Menu>
                <Tooltip content="Versions and storage">
                  <MenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Versions and storage"
                      loading={busy !== null}
                      disabled={busy !== null}
                    >
                      <Ellipsis />
                    </Button>
                  </MenuTrigger>
                </Tooltip>
                <MenuContent className="w-72">
                  <MenuLabel>
                    {file.live
                      ? `Live from ${hostOf(file.sourceUrl)}${file.version ? ` · ${file.version}` : ""}`
                      : `Saved copy · ${formatBytes(file.sizeBytes)}`}
                  </MenuLabel>
                  <MenuItem onSelect={checkNow}>
                    <RefreshCw />
                    Check for a newer version
                  </MenuItem>
                  {file.arxivId && currentVersion > 1 && (
                    <MenuSub>
                      <MenuSubTrigger>
                        <History />
                        Open an older version
                      </MenuSubTrigger>
                      <MenuSubContent>
                        {Array.from({ length: currentVersion - 1 }, (_, i) => currentVersion - 1 - i).map((v) => (
                          <MenuItem key={v} onSelect={() => setOlderVersion(v)}>
                            v{v}
                          </MenuItem>
                        ))}
                      </MenuSubContent>
                    </MenuSub>
                  )}
                  <MenuSeparator />
                  {file.live ? (
                    <MenuItem onSelect={() => switchLive(false)}>
                      <HardDriveDownload />
                      Keep a copy here (offline reading)
                    </MenuItem>
                  ) : (
                    <MenuItem onSelect={() => switchLive(true)}>
                      <Radio />
                      Read live, remove the saved copy ({formatBytes(file.sizeBytes)})
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
            <Tooltip content={sidebarOpen ? "Hide sidebar" : "Show highlights, notes and AI"}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSidebarOpen((o) => !o)}
                aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                aria-expanded={sidebarOpen}
              >
                {sidebarOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </Tooltip>
          </div>
        )}
      </header>

      {!file ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NoPdf
            paper={paper}
            onAttached={async (id) => {
              setChosenFileId(id);
              await qc.invalidateQueries({ queryKey: ["paper", paperId] });
              void qc.invalidateQueries({ queryKey: ["library"] });
            }}
          />
        </div>
      ) : (
        <>
          {olderVersion ? (
            <div
              role="status"
              className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-[13px]"
            >
              <History className="size-4 shrink-0 text-muted" aria-hidden />
              <p className="min-w-0 flex-1">
                You are viewing v{olderVersion}, an older version. Highlights and notes are on {file.version}.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setOlderVersion(null)}>
                Back to {file.version}
              </Button>
            </div>
          ) : (
            <VersionNoticeBar file={file} onDismiss={dismissNotice} />
          )}
          <div className="relative flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <PdfViewer
                key={viewUrl}
                url={viewUrl!}
                liveHost={file.live && !olderVersion ? hostOf(file.sourceUrl) : olderVersion ? "arxiv.org" : null}
                readOnly={!!olderVersion}
                highlights={olderVersion ? NO_HIGHLIGHTS : placedHighlights}
                selectedId={selectedId}
                flashId={flashId}
                jump={jump}
                aiEnabled={aiEnabled}
                onSelectHighlight={(id) => {
                  setSelectedId(id);
                  if (id) {
                    setTab("highlights");
                    setSidebarOpen(true);
                  }
                }}
                onCreate={onCreate}
                onAi={onAi}
                onQuote={onQuote}
                onPageChange={onPageChange}
              />
              <ReaderGraphDock paperId={paperId} />
            </div>
            {sidebarOpen && (
              <>
                <div
                  className="fixed inset-0 z-30 bg-black/20 lg:hidden"
                  onClick={() => setSidebarOpen(false)}
                  aria-hidden
                />
                <aside
                  aria-label="Reader sidebar"
                  style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
                  className={cn(
                    "z-40 flex min-h-0 w-[min(24rem,92vw)] shrink-0 flex-col border-l border-border bg-bg lg:w-[var(--sidebar-w)]",
                    "fixed inset-y-0 right-0 shadow-xl lg:relative lg:shadow-none",
                  )}
                >
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    title="Drag to resize"
                    onPointerDown={startResize}
                    onDoubleClick={() => setStoredWidth("420")}
                    className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-accent/20 active:bg-accent/30 lg:block"
                  />
                  <div className="flex shrink-0 justify-end border-b border-border px-2 py-1 lg:hidden">
                    <Button size="sm" variant="ghost" onClick={() => setSidebarOpen(false)}>
                      <X />
                      Close
                    </Button>
                  </div>
                  <ReaderSidebar
                    paperId={paperId}
                    tab={tab}
                    onTabChange={setTab}
                    highlights={highlights}
                    selectedId={selectedId}
                    onJump={(h) => {
                      jumpTo(h);
                      if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false);
                    }}
                    onUpdate={(id, patch) => update.mutate({ id, ...patch })}
                    onDelete={(id) => {
                      if (selectedId === id) setSelectedId(null);
                      remove.mutate(id);
                    }}
                    notes={paper.notes}
                    paperTitle={paper.title}
                    quote={quote}
                    aiEnabled={aiEnabled}
                    page={page}
                    aiRequest={aiRequest}
                    onJumpToPage={(n) => setJump({ page: n, nonce: Date.now() })}
                  />
                </aside>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
