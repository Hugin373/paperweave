import { cn } from "@/lib/cn";

function Swatch({ shape, color }: { shape: "circle" | "diamond" | "square"; color: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2.5",
        shape === "circle" && "rounded-full",
        shape === "square" && "rounded-[2px]",
        shape === "diamond" && "rotate-45 rounded-[1px]",
      )}
      style={{ background: color }}
    />
  );
}

function Line({ dashed, color, arrow }: { dashed?: boolean; color: string; arrow?: boolean }) {
  return (
    <svg width="22" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2={arrow ? 16 : 21}
        y2="4"
        stroke={color}
        strokeWidth="1.6"
        strokeDasharray={dashed ? "3 2" : undefined}
      />
      {arrow && <path d="M15 1 L21 4 L15 7 Z" fill={color} />}
    </svg>
  );
}

export function KnowledgeLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted", className)}
      aria-label="Legend"
    >
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--node-paper)" />
        Paper
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch shape="diamond" color="var(--node-concept)" />
        Concept
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch shape="square" color="var(--node-note)" />
        Note
      </span>
      <span className="flex items-center gap-1.5">
        <Line color="var(--subtle)" arrow />
        Cites
      </span>
      <span className="flex items-center gap-1.5">
        <Line color="var(--node-concept)" />
        Concept link
      </span>
      <span className="flex items-center gap-1.5">
        <Line color="var(--node-note)" />
        Note link
      </span>
    </div>
  );
}

/** Legend for "color by collection". */
export function CollectionLegend({
  collections,
  showRing,
  className,
}: {
  collections: { id: string; name: string; swatch: string }[];
  /** Whether any paper shows the ring for a second collection. */
  showRing: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted", className)}
      aria-label="Legend"
    >
      {collections.map((c) => (
        <span key={c.id} className="flex max-w-48 items-center gap-1.5">
          <Swatch shape="circle" color={c.swatch} />
          <span className="truncate">{c.name}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--border-strong)" />
        {collections.length ? "No collection · concepts · notes" : "No collections in view"}
      </span>
      {showRing && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-full border-2 border-muted" />
          Ring: also in another collection
        </span>
      )}
    </div>
  );
}

export function CitationLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted", className)}
      aria-label="Legend"
    >
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--accent)" />
        This paper
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--node-paper)" />
        References (earlier work)
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--node-note)" />
        Cited by (later work)
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch shape="circle" color="var(--subtle)" />
        Expanded
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block size-2.5 rounded-full border-2"
          style={{ borderColor: "var(--warning)" }}
        />
        In your library
      </span>
      <span className="flex items-center gap-1.5">
        <Line color="var(--subtle)" arrow />
        Cites
      </span>
    </div>
  );
}
