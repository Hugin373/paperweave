"use client";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, StickyNote, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Document, Page, pdfjs } from "react-pdf";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/menu";
import { ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { HighlightDto, HighlightRect } from "@/lib/types";
import {
  collapseWhitespace,
  mergeLineRects,
  normalizeRects,
  pointInRects,
  quoteContext,
  type HighlightColor,
} from "./geometry";
import { NoteDraftPopover, SelectionPopover, type PendingSelection } from "./selection-popover";
import type { NewHighlight } from "./use-highlights";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const GAP = 16;
const PAD = 16;
const MAX_BASE_WIDTH = 920;
const DEFAULT_ASPECT = 11 / 8.5;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** Pages are rendered from this many screens above the viewport… */
const RENDER_ABOVE = 1.5;
/** …to this many below (reading usually goes down). */
const RENDER_BELOW = 2.5;
/** Recently rendered pages stay rendered, so scrolling back does not redraw them. */
const KEEP_RENDERED = 14;

interface Layout {
  heights: number[];
  offsets: number[];
  total: number;
}

/** Pages overlapping the render window around the viewport. */
function windowPages(top: number, height: number, layout: Layout): number[] {
  const from = top - height * RENDER_ABOVE;
  const to = top + height * (1 + RENDER_BELOW);
  const pages: number[] = [];
  layout.offsets.forEach((off, i) => {
    if (off + layout.heights[i] >= from && off <= to) pages.push(i + 1);
  });
  return pages;
}

export interface JumpRequest {
  page: number;
  /** Normalized vertical position within the page (0..1). */
  y?: number;
  nonce: number;
}

export interface PdfViewerProps {
  /** Where the PDF is loaded from: this app, or the source itself (arXiv). */
  url: string;
  /** For a live PDF: the host it is read from (named when it cannot be reached). */
  liveHost?: string | null;
  /** An older version shown for reference: no highlights or notes can be added. */
  readOnly?: boolean;
  highlights: HighlightDto[];
  selectedId: string | null;
  flashId: string | null;
  jump: JumpRequest | null;
  aiEnabled: boolean;
  onSelectHighlight: (id: string | null) => void;
  onCreate: (h: NewHighlight) => Promise<HighlightDto | undefined>;
  onAi: (req: { text: string; pageNumber: number; question?: string }) => void;
  onQuote?: (req: { text: string; pageNumber: number }) => void;
  onPageChange?: (page: number, numPages: number) => void;
}

interface NoteDraft {
  pageNumber: number;
  x: number;
  y: number;
  left: number;
  top: number;
}

function isTypingTarget(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

const NO_HIGHLIGHTS: HighlightDto[] = [];

function PagePlaceholder({ h }: { h: number }) {
  return (
    <div className="flex items-center justify-center" style={{ height: h }}>
      <Spinner />
    </div>
  );
}

/**
 * One page slot. Memoized so that scrolling (which re-renders the viewer every frame) only touches the
 * pages whose rendering state actually changes.
 */
const PageBox = memo(function PageBox({
  n,
  top,
  h,
  pageWidth,
  left,
  render,
  pageHighlights,
  selectedId,
  flashId,
  onAspect,
  onSelectHighlight,
}: {
  n: number;
  top: number;
  h: number;
  pageWidth: number;
  left: number;
  render: boolean;
  pageHighlights: HighlightDto[];
  selectedId: string | null;
  flashId: string | null;
  onAspect: (page: number, aspect: number) => void;
  onSelectHighlight: (id: string | null) => void;
}) {
  return (
    <div
      key={n}
      data-page-box={n}
      className="absolute overflow-hidden bg-white shadow-sm ring-1 ring-black/5"
      style={{ top, height: h, width: pageWidth, left }}
      aria-label={`Page ${n}`}
    >
      {render ? (
        // react-pdf loads pages with Suspense. Each page needs its own boundary: otherwise a page that
        // starts loading suspends the shared boundary above and every rendered page is hidden and redrawn.
        <Suspense fallback={<PagePlaceholder h={h} />}>
          <Page
            pageNumber={n}
            width={pageWidth}
            renderAnnotationLayer
            renderTextLayer
            loading={<PagePlaceholder h={h} />}
            onLoadSuccess={(page) => onAspect(n, page.originalHeight / page.originalWidth)}
          />
        </Suspense>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-subtle">{n}</div>
      )}
      {pageHighlights.map((hl) =>
        hl.kind === "note" ? (
          <button
            key={hl.id}
            type="button"
            data-reader-popover
            onClick={(e) => {
              e.stopPropagation();
              onSelectHighlight(hl.id);
            }}
            className={cn(
              "absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-warning p-1 text-white shadow-md hover:scale-110",
              (hl.id === selectedId || hl.id === flashId) && "ring-2 ring-accent ring-offset-1",
              hl.id === flashId && "animate-pulse",
            )}
            style={{ left: `${hl.rects[0].x * 100}%`, top: `${hl.rects[0].y * 100}%` }}
            aria-label={`Page note: ${hl.comment.slice(0, 60)}`}
            title={hl.comment}
          >
            <StickyNote className="size-3.5" />
          </button>
        ) : (
          hl.rects.map((r, j) => (
            <div
              key={`${hl.id}-${j}`}
              aria-hidden
              className={cn(
                "pointer-events-none absolute rounded-[2px] mix-blend-multiply transition-[background-color,box-shadow]",
                hl.id === flashId && "animate-pulse",
              )}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.width * 100}%`,
                height: `${r.height * 100}%`,
                // A selected highlight is shown in its own color: a deeper tint with an underline.
                ...(hl.id === selectedId || hl.id === flashId
                  ? {
                      background: `color-mix(in srgb, var(--hl-${hl.color}-strong) 45%, transparent)`,
                      boxShadow: `inset 0 -2px 0 var(--hl-${hl.color}-strong)`,
                    }
                  : { background: `var(--hl-${hl.color})` }),
              }}
            />
          ))
        ),
      )}
    </div>
  );
});

export default function PdfViewer({
  url,
  liveHost = null,
  readOnly = false,
  highlights,
  selectedId,
  flashId,
  jump,
  aiEnabled,
  onSelectHighlight,
  onCreate,
  onAi,
  onQuote,
  onPageChange,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // Scroll position plus the most recently rendered pages (newest first), updated at most once a frame.
  const [view, setView] = useState({ top: 0, height: 800, kept: [] as number[] });
  const scrollFrame = useRef(0);
  const [numPages, setNumPages] = useState(0);
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const [baseAspect, setBaseAspect] = useState(DEFAULT_ASPECT);
  // Page geometry is only reliable once the first page's size is known.
  const [aspectReady, setAspectReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [pageInput, setPageInput] = useState<string | null>(null);

  // The first pages load with range requests; the rest of the file then streams in the background,
  // so later pages do not wait for the network when they are reached.
  const options = useMemo(() => ({ disableAutoFetch: false, disableStream: false }), []);

  const layoutRef = useRef<Layout>({ heights: [], offsets: [], total: 0 });

  /** Records the scroll position and remembers which pages are (and were recently) rendered. */
  const updateView = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const height = el.clientHeight || 800;
    const win = windowPages(top, height, layoutRef.current);
    setView((v) => {
      const kept = [...win, ...v.kept.filter((p) => !win.includes(p))].slice(0, Math.max(KEEP_RENDERED, win.length));
      const same =
        v.top === top && v.height === height && kept.length === v.kept.length && kept.every((p, i) => p === v.kept[i]);
      return same ? v : { top, height, kept };
    });
  }, []);

  // Track the available width and height.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
      updateView();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(scrollFrame.current);
    };
  }, [updateView]);

  const baseWidth = Math.max(240, Math.min(containerWidth - PAD * 2, MAX_BASE_WIDTH));
  const pageWidth = Math.round(baseWidth * zoom);

  const layout = useMemo<Layout>(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    let y = PAD;
    for (let i = 1; i <= numPages; i++) {
      const h = Math.round(pageWidth * (aspects[i] ?? baseAspect));
      offsets.push(y);
      heights.push(h);
      y += h + GAP;
    }
    return { heights, offsets, total: y + PAD - GAP };
  }, [numPages, pageWidth, aspects, baseAspect]);

  useEffect(() => {
    layoutRef.current = layout;
    // The layout changed (document loaded, zoom, page sizes): recompute which pages to render.
    const frame = requestAnimationFrame(updateView);
    return () => cancelAnimationFrame(frame);
  }, [layout, updateView]);

  // Current page = the last page whose top is above 35% of the viewport.
  const currentPage = useMemo(() => {
    const probe = view.top + view.height * 0.35;
    let page = 1;
    for (let i = 0; i < layout.offsets.length; i++) if (layout.offsets[i] <= probe) page = i + 1;
    return page;
  }, [view.top, view.height, layout]);

  // Pages near the viewport, plus recently rendered ones (kept so scrolling back is instant).
  const renderRange = useMemo(
    () => new Set([...windowPages(view.top, view.height, layout), ...view.kept]),
    [view, layout],
  );

  useEffect(() => {
    if (numPages) onPageChange?.(currentPage, numPages);
  }, [currentPage, numPages, onPageChange]);

  const scrollToPage = useCallback((page: number, y = 0) => {
    const el = scrollRef.current;
    const { offsets, heights } = layoutRef.current;
    if (!el || !offsets.length) return;
    const idx = Math.min(Math.max(page, 1), offsets.length) - 1;
    const top = offsets[idx] + y * heights[idx] - (y > 0 ? el.clientHeight * 0.3 : PAD);
    el.scrollTo({ top: Math.max(0, top), behavior: y > 0 ? "smooth" : "auto" });
  }, []);

  // ---------------------------------------------------------------------------
  // Links inside the PDF (citations → reference list, figures, sections)
  // ---------------------------------------------------------------------------

  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  // Where the reader was before following links, newest last ("Back to page N").
  const [linkHistory, setLinkHistory] = useState<{ top: number; page: number }[]>([]);

  const followLink = useCallback(
    async ({ dest, pageNumber }: { dest?: unknown; pageNumber: number }) => {
      const el = scrollRef.current;
      if (!el) return;
      let y = 0;
      // An explicit destination is [pageRef, { name }, ...args]; the args give the target's position.
      if (Array.isArray(dest) && pdfRef.current) {
        const kind = (dest[1] as { name?: string } | undefined)?.name;
        const args = dest.slice(2) as (number | null)[];
        const top =
          kind === "XYZ" ? args[1] : kind === "FitH" || kind === "FitBH" ? args[0] : kind === "FitR" ? args[3] : null;
        if (typeof top === "number") {
          try {
            const page = await pdfRef.current.getPage(pageNumber);
            const [, y0, , y1] = page.view;
            y = Math.min(0.98, Math.max(0, 1 - (top - y0) / (y1 - y0)));
          } catch {
            /* top of the page */
          }
        }
      }
      // The clicked link has focus: its page is where the reader was.
      const from =
        Number(document.activeElement?.closest<HTMLElement>("[data-page-box]")?.dataset.pageBox) || currentPage;
      setLinkHistory((h) => [...h.slice(-9), { top: el.scrollTop, page: from }]);
      setPending(null);
      // The target line lands a third of the way down the view (or the page top, without a position).
      scrollToPage(pageNumber, y);
    },
    [currentPage, scrollToPage],
  );

  const goBack = () => {
    const last = linkHistory.at(-1);
    const el = scrollRef.current;
    if (!last || !el) return;
    setLinkHistory((h) => h.slice(0, -1));
    el.scrollTo({ top: last.top, behavior: "smooth" });
  };

  // External jump requests (?page=, ?highlight=, sidebar clicks).
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jump || !numPages || !aspectReady || !containerWidth || handledJump.current === jump.nonce) return;
    handledJump.current = jump.nonce;
    requestAnimationFrame(() => scrollToPage(jump.page, jump.y));
  }, [jump, numPages, aspectReady, containerWidth, scrollToPage]);

  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      updateView();
    });
  };

  const applyZoom = useCallback((next: number) => {
    const el = scrollRef.current;
    const ratio = el && el.scrollHeight ? el.scrollTop / el.scrollHeight : 0;
    setPending(null);
    setNoteDraft(null);
    setZoom(Math.min(3, Math.max(0.5, Math.round(next * 100) / 100)));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (el) el.scrollTop = ratio * el.scrollHeight;
      }),
    );
  }, []);

  // Ctrl/⌘ + wheel and trackpad pinch zoom the document (not the whole page) around the pointer.
  // During the gesture the content is scaled with CSS for instant feedback; the pages are re-rendered
  // at the new size once the gesture pauses.
  const contentRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const gesture = useRef<{ target: number; anchorX: number; anchorY: number; timer: number } | null>(null);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const commit = () => {
      const g = gesture.current;
      const content = contentRef.current;
      gesture.current = null;
      if (!g || !content) return;
      const from = zoomRef.current;
      const to = Math.min(3, Math.max(0.5, Math.round(g.target * 100) / 100));
      const f = to / from;
      content.style.transform = "";
      content.style.transformOrigin = "";
      setPending(null);
      setNoteDraft(null);
      setZoom(to);
      // Keep the document point under the pointer in place.
      const rect = el.getBoundingClientRect();
      const px = g.anchorX - rect.left;
      const py = g.anchorY - rect.top;
      const docX = el.scrollLeft + px;
      const docY = el.scrollTop + py;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          el.scrollTop = Math.max(0, (docY - PAD) * f + PAD - py);
          el.scrollLeft = Math.max(0, docX * f - px);
        }),
      );
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const content = contentRef.current;
      if (!content) return;
      const g = (gesture.current ??= { target: zoomRef.current, anchorX: e.clientX, anchorY: e.clientY, timer: 0 });
      // Pixel-mode deltas (trackpads) are small and frequent; line-mode deltas (mouse wheels) are coarse.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      g.target = Math.min(3, Math.max(0.5, g.target * Math.exp(-delta * 0.001)));
      g.anchorX = e.clientX;
      g.anchorY = e.clientY;
      const rect = el.getBoundingClientRect();
      content.style.transformOrigin = `${el.scrollLeft + e.clientX - rect.left}px ${el.scrollTop + e.clientY - rect.top}px`;
      content.style.transform = `scale(${g.target / zoomRef.current})`;
      window.clearTimeout(g.timer);
      g.timer = window.setTimeout(commit, 160);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (gesture.current) window.clearTimeout(gesture.current.timer);
    };
  }, []);

  const zoomIn = useCallback(() => applyZoom(ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? 3), [applyZoom, zoom]);
  const zoomOut = useCallback(
    () => applyZoom([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? 0.5),
    [applyZoom, zoom],
  );
  const fitWidth = useCallback(
    () => applyZoom((containerWidth - PAD * 2) / baseWidth),
    [applyZoom, containerWidth, baseWidth],
  );

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setPending(null);
        setNoteDraft(null);
        setNoteMode(false);
      } else if (e.key === "n" || e.key === "j") {
        e.preventDefault();
        scrollToPage(currentPage + 1);
      } else if (e.key === "p" || e.key === "k") {
        e.preventDefault();
        scrollToPage(currentPage - 1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        fitWidth();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentPage, scrollToPage, zoomIn, zoomOut, fitWidth]);

  // ---------------------------------------------------------------------------
  // Selection → highlight popover
  // ---------------------------------------------------------------------------

  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    const container = scrollRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !container) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>("[data-page-box]");
    if (!pageEl || !container.contains(pageEl)) return;
    const pageNumber = Number(pageEl.dataset.pageBox);
    const text = collapseWhitespace(sel.toString()).slice(0, 10000);
    if (!text) return;
    const rects = mergeLineRects(normalizeRects(range.getClientRects(), pageEl.getBoundingClientRect())).filter(
      (r) => r.width > 0.002 && r.height > 0.002,
    );
    if (!rects.length) return;
    const pageText = pageEl.querySelector(".textLayer")?.textContent ?? "";
    const { prefix, suffix } = quoteContext(pageText, text);
    const box = range.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    setNoteDraft(null);
    setPending({
      pageNumber,
      rects,
      text,
      prefix,
      suffix,
      left: box.left - cRect.left + container.scrollLeft + box.width / 2,
      top: box.bottom - cRect.top + container.scrollTop + 8,
    });
  }, []);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  const createFromSelection = async (color: HighlightColor, comment = "") => {
    if (!pending) return;
    const h = await onCreate({
      kind: "highlight",
      pageNumber: pending.pageNumber,
      rects: pending.rects,
      selectedText: pending.text,
      prefix: pending.prefix,
      suffix: pending.suffix,
      color,
      comment,
    });
    clearSelection();
    if (h) onSelectHighlight(h.id);
  };

  const onPointerUp = (e: ReactMouseEvent) => {
    if (readOnly || (e.target as HTMLElement).closest("[data-reader-popover]")) return;
    // Let the browser finalize the selection first.
    setTimeout(readSelection, 0);
  };

  const onClick = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-reader-popover]") || target.closest("a")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pageEl = target.closest<HTMLElement>("[data-page-box]");
    const container = scrollRef.current;
    if (!pageEl || !container) return;
    const pageNumber = Number(pageEl.dataset.pageBox);
    const r = pageEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (noteMode) {
      const cRect = container.getBoundingClientRect();
      setPending(null);
      setNoteDraft({
        pageNumber,
        x,
        y,
        left: e.clientX - cRect.left + container.scrollLeft,
        top: e.clientY - cRect.top + container.scrollTop + 12,
      });
      return;
    }
    const hit = [...highlights]
      .reverse()
      .find((h) => h.kind === "highlight" && h.pageNumber === pageNumber && pointInRects(x, y, h.rects));
    if (hit) onSelectHighlight(hit.id);
  };

  const saveNote = async (comment: string) => {
    if (!noteDraft) return;
    const rect: HighlightRect = { x: noteDraft.x, y: noteDraft.y, width: 0, height: 0 };
    const h = await onCreate({
      kind: "note",
      pageNumber: noteDraft.pageNumber,
      rects: [rect],
      selectedText: "",
      prefix: "",
      suffix: "",
      color: "yellow",
      comment,
    });
    setNoteDraft(null);
    setNoteMode(false);
    if (h) onSelectHighlight(h.id);
  };

  const onAspect = useCallback(
    (n: number, aspect: number) => {
      if (Math.abs(aspect - baseAspect) > 0.01) setAspects((a) => (a[n] === aspect ? a : { ...a, [n]: aspect }));
    },
    [baseAspect],
  );

  const byPage = useMemo(() => {
    const m = new Map<number, HighlightDto[]>();
    for (const h of highlights) m.set(h.pageNumber, [...(m.get(h.pageNumber) ?? []), h]);
    return m;
  }, [highlights]);

  const contentWidth = Math.max(containerWidth, pageWidth + PAD * 2);

  const backTo = linkHistory.at(-1);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {backTo && (
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-0.5 rounded-full border border-border bg-surface py-1 pr-1 pl-1 shadow-lg">
          <Button size="sm" variant="ghost" className="rounded-full" onClick={goBack}>
            <ArrowLeft />
            Back to page {backTo.page}
          </Button>
          <Tooltip content="Dismiss">
            <Button
              size="icon-sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setLinkHistory([])}
              aria-label="Dismiss back button"
            >
              <X />
            </Button>
          </Tooltip>
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Reader controls"
        className="flex flex-wrap items-center gap-1 border-b border-border bg-surface/80 px-2 py-1.5 backdrop-blur"
      >
        <Tooltip content="Previous page (p)">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => scrollToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronUp />
          </Button>
        </Tooltip>
        <Tooltip content="Next page (n)">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => scrollToPage(currentPage + 1)}
            disabled={!numPages || currentPage >= numPages}
            aria-label="Next page"
          >
            <ChevronDown />
          </Button>
        </Tooltip>
        <form
          className="flex items-center gap-1 text-[13px] text-muted"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(pageInput);
            if (pageInput && Number.isFinite(n)) scrollToPage(n);
            setPageInput(null);
            (e.currentTarget.elements.namedItem("reader-page") as HTMLInputElement | null)?.blur();
          }}
        >
          <label htmlFor="reader-page" className="sr-only">
            Page number
          </label>
          <input
            id="reader-page"
            inputMode="numeric"
            name="reader-page"
            value={pageInput ?? String(currentPage)}
            onFocus={() => setPageInput(String(currentPage))}
            onBlur={() => setPageInput(null)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            className="h-7 w-11 rounded-md border border-border bg-surface px-1.5 text-center text-[13px] text-text focus:border-accent focus:outline-none"
          />
          <span>/ {numPages || "–"}</span>
        </form>
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Tooltip content="Zoom out (−, or Ctrl + scroll)">
          <Button size="icon-sm" variant="ghost" onClick={zoomOut} disabled={zoom <= 0.5} aria-label="Zoom out">
            <ZoomOut />
          </Button>
        </Tooltip>
        <span className="w-11 text-center text-[13px] text-muted tabular-nums" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip content="Zoom in (+, or Ctrl + scroll)">
          <Button size="icon-sm" variant="ghost" onClick={zoomIn} disabled={zoom >= 3} aria-label="Zoom in">
            <ZoomIn />
          </Button>
        </Tooltip>
        <Tooltip content="Fit width (0)">
          <Button size="icon-sm" variant="ghost" onClick={fitWidth} aria-label="Fit to width">
            <Maximize2 />
          </Button>
        </Tooltip>
        {!readOnly && <div className="mx-1 h-5 w-px bg-border" aria-hidden />}
        {!readOnly && (
          <Button
            size="sm"
            variant={noteMode ? "primary" : "ghost"}
            onClick={() => {
              setNoteMode((m) => !m);
              setNoteDraft(null);
            }}
            aria-pressed={noteMode}
          >
            <StickyNote />
            {noteMode ? "Click the page to place a note" : "Add note"}
          </Button>
        )}
        <span className="ml-auto hidden pr-1 text-[12px] text-subtle lg:inline">
          {readOnly ? "Older version: highlights are on the newest version" : "Select text to highlight"}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onMouseUp={onPointerUp}
        onKeyUp={(e) => !readOnly && e.shiftKey && setTimeout(readSelection, 0)}
        onClick={onClick}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest("[data-reader-popover]")) setPending(null);
        }}
        role="region"
        aria-label="PDF document"
        className={cn(
          "relative min-h-0 flex-1 overflow-auto bg-surface-3/60 focus-visible:outline-none",
          noteMode && "cursor-crosshair",
        )}
      >
        {loadError ? (
          <div className="p-6">
            <ErrorState
              title="This PDF could not be opened"
              error={
                /password/i.test(loadError.message)
                  ? "The file is password-protected."
                  : liveHost
                    ? `It is read live from ${liveHost}, which could not be reached or did not return a PDF. Try again later, or keep a copy here for offline reading.`
                    : "The file may be damaged or not a valid PDF. Try downloading it, or upload another copy."
              }
            />
          </div>
        ) : (
          <Document
            file={url}
            options={options}
            onItemClick={followLink}
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer nofollow"
            onLoadSuccess={async (pdf) => {
              pdfRef.current = pdf;
              setNumPages(pdf.numPages);
              try {
                const first = await pdf.getPage(1);
                const vp = first.getViewport({ scale: 1 });
                setBaseAspect(vp.height / vp.width);
              } catch {
                /* keep default aspect */
              }
              setAspectReady(true);
            }}
            onLoadError={(err) => setLoadError(err)}
            loading={
              <div className="flex h-64 items-center justify-center">
                <Spinner label="Opening PDF…" />
              </div>
            }
            error={<span />}
          >
            <div ref={contentRef} style={{ height: layout.total, width: contentWidth }} className="relative">
              {layout.offsets.map((top, i) => (
                <PageBox
                  key={i + 1}
                  n={i + 1}
                  top={top}
                  h={layout.heights[i]}
                  pageWidth={pageWidth}
                  left={Math.max(PAD, (contentWidth - pageWidth) / 2)}
                  render={renderRange.has(i + 1)}
                  pageHighlights={byPage.get(i + 1) ?? NO_HIGHLIGHTS}
                  selectedId={selectedId}
                  flashId={flashId}
                  onAspect={onAspect}
                  onSelectHighlight={onSelectHighlight}
                />
              ))}
            </div>
          </Document>
        )}

        {pending && (
          <SelectionPopover
            selection={pending}
            aiEnabled={aiEnabled}
            onHighlight={createFromSelection}
            onAi={(question) => {
              onAi({ text: pending.text, pageNumber: pending.pageNumber, question });
              clearSelection();
            }}
            onQuote={
              onQuote
                ? () => {
                    onQuote({ text: pending.text, pageNumber: pending.pageNumber });
                    clearSelection();
                  }
                : undefined
            }
            onClose={clearSelection}
          />
        )}
        {noteDraft && (
          <NoteDraftPopover
            left={noteDraft.left}
            top={noteDraft.top}
            onSave={saveNote}
            onCancel={() => setNoteDraft(null)}
          />
        )}
      </div>
    </div>
  );
}
