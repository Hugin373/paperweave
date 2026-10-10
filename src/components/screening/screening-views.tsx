"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderPlus, ListChecks, Pause, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAlerts } from "@/components/alerts/alerts-view";
import { PaperCard } from "@/components/papers/paper-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useCollections } from "@/lib/hooks";
import type { ScreeningDecision, ScreeningDetail, ScreeningItemDto, ScreeningSummary } from "@/lib/types";

const DECISION: Record<ScreeningDecision, { label: string; tone: "success" | "danger" | "warning" | "neutral" }> = {
  include: { label: "Include", tone: "success" },
  exclude: { label: "Exclude", tone: "danger" },
  maybe: { label: "Maybe", tone: "warning" },
  pending: { label: "Not screened yet", tone: "neutral" },
};

/** Decided out of total, as a thin bar with the counts. */
function Progress({ s }: { s: ScreeningSummary }) {
  const decided = s.total - s.counts.pending;
  const pct = s.total ? Math.round((decided / s.total) * 100) : 0;
  return (
    <div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[12.5px] text-muted">
        {decided} of {s.total} screened · {s.counts.include} include · {s.counts.maybe} maybe · {s.counts.exclude}{" "}
        exclude
        {s.status === "paused" ? " · paused" : s.status === "running" ? " · working…" : ""}
      </p>
    </div>
  );
}

function NewScreening({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const collections = useCollections();
  const alerts = useAlerts();
  // The choices must be current (a collection may have just been made, here or on another computer).
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["collections"] });
    void qc.invalidateQueries({ queryKey: ["alerts"], exact: true });
  }, [qc]);
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [from, setFrom] = useState("");
  const [fullText, setFullText] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      const [kind, id] = from.split(":");
      return api<{ id: string; papers: number }>("/api/screenings", {
        body: {
          title,
          criteria,
          useFullText: fullText,
          ...(kind === "collection" ? { collectionId: id } : { savedSearchId: id }),
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`Screening ${r.papers} papers. It runs in the background.`);
      onCreated(r.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-[15px] font-semibold">New screening</h2>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title, e.g. Cardiac MRI segmentation review"
        aria-label="Title"
        required
      />
      <Textarea
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
        rows={5}
        aria-label="Inclusion and exclusion criteria"
        placeholder={
          "Include: deep learning methods for cardiac MRI segmentation, evaluated on public datasets.\nExclude: reviews, CT-only studies, papers without quantitative evaluation."
        }
        required
        minLength={10}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Papers to screen"
          required
          className="sm:flex-1"
        >
          <option value="">Papers to screen…</option>
          {collections.data?.length ? (
            <optgroup label="Collections">
              {collections.data.map((c) => (
                <option key={c.id} value={`collection:${c.id}`}>
                  {c.name} ({c.paperCount})
                </option>
              ))}
            </optgroup>
          ) : null}
          {alerts.data?.searches.length ? (
            <optgroup label="Saved searches">
              {alerts.data.searches.map((s) => (
                <option key={s.id} value={`search:${s.id}`}>
                  {s.query} ({s.total})
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={fullText}
            onChange={(e) => setFullText(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Also read the full text where available (slower)
        </label>
      </div>
      <p className="text-[12.5px] text-subtle">
        The AI decides include / exclude / maybe for each paper with a reason and the sentence it rests on. Review and
        change any decision.
      </p>
      <Button
        type="submit"
        variant="primary"
        loading={create.isPending}
        disabled={!title.trim() || criteria.trim().length < 10 || !from}
      >
        Start screening
      </Button>
    </form>
  );
}

/** All screenings, and starting a new one. */
export function ScreeningList() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["screenings"],
    queryFn: () => api<ScreeningSummary[]>("/api/screenings"),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "running") ? 5000 : false),
  });
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-5 text-accent" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">Screening</h1>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            New screening
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">
        Screen many papers against your inclusion and exclusion criteria, as for a systematic review. The assistant can
        start one too.
      </p>
      {creating && <NewScreening onCreated={(id) => router.push(`/screening/${id}`)} />}
      {list.isPending ? (
        <Skeleton className="h-24" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data.length ? (
        !creating && (
          <EmptyState
            icon={ListChecks}
            title="No screenings yet"
            description="Start one from a collection or a saved search."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New screening
              </Button>
            }
          />
        )
      ) : (
        <ul className="space-y-2">
          {list.data.map((s) => (
            <li key={s.id}>
              <Link
                href={`/screening/${s.id}`}
                className="block rounded-xl border border-border bg-surface p-3.5 hover:border-accent/50"
              >
                <p className="mb-2 flex items-center gap-2 text-[14.5px] font-medium">
                  {s.title}
                  <span className="text-[12px] font-normal text-subtle">started {relativeTime(s.createdAt)}</span>
                </p>
                <Progress s={s} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({ item, screeningId }: { item: ScreeningItemDto; screeningId: string }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: Exclude<ScreeningDecision, "pending">) =>
      api(`/api/screenings/${screeningId}/decisions`, { body: { paperId: item.paper.id, decision } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["screenings"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const d = DECISION[item.decision];
  return (
    <PaperCard
      paper={item.paper}
      dense
      highlight={
        <Badge tone={d.tone}>
          {d.label}
          {item.decidedBy === "user" ? " · you" : item.decidedBy === "ai" ? " · AI" : ""}
        </Badge>
      }
      footer={
        item.decision !== "pending" ? (
          <div className="space-y-1 text-[13px]">
            <p className="text-text/85">{item.reason}</p>
            {item.evidence && (
              <p className="border-l-2 border-border-strong pl-2 text-muted italic">“{item.evidence}”</p>
            )}
            <div className="flex gap-1 pt-1">
              {(["include", "maybe", "exclude"] as const).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={item.decision === k ? "secondary" : "ghost"}
                  aria-pressed={item.decision === k}
                  onClick={() => decide.mutate(k)}
                  disabled={decide.isPending}
                >
                  {DECISION[k].label}
                </Button>
              ))}
            </div>
          </div>
        ) : undefined
      }
    />
  );
}

/** One screening: progress, decisions by filter, and what to do with the result. */
export function ScreeningDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<ScreeningDecision | "all">("all");
  const detail = useQuery({
    queryKey: ["screenings", id],
    queryFn: () => api<ScreeningDetail>(`/api/screenings/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 4000 : false),
  });
  const toggle = useMutation({
    mutationFn: (running: boolean) => api(`/api/screenings/${id}`, { method: "PATCH", body: { running } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["screenings"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/screenings/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["screenings"] });
      router.push("/screening");
    },
  });
  const save = useMutation({
    mutationFn: (name: string) =>
      api<{ collectionId: string; papers: number }>(`/api/screenings/${id}/collection`, { body: { name } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["collections"] });
      toast.success(`Saved ${r.papers} included papers as a collection.`, {
        action: { label: "Open", onClick: () => router.push(`/library?collection=${r.collectionId}`) },
      });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (detail.isPending) return <Skeleton className="mx-auto h-40 max-w-4xl" />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  const s = detail.data;
  const items = filter === "all" ? s.items : s.items.filter((i) => i.decision === filter);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <Link href="/screening" className="text-[13px] text-muted hover:text-text">
          ← Screening
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{s.title}</h1>
      </div>
      <details className="rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm">
        <summary className="cursor-pointer font-medium">
          Criteria{s.useFullText ? " · full text read where available" : ""}
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-muted">{s.criteria}</p>
      </details>
      <Progress s={s} />
      <div className="flex flex-wrap gap-2">
        {s.status !== "done" &&
          (s.status === "running" ? (
            <Button size="sm" variant="secondary" onClick={() => toggle.mutate(false)} loading={toggle.isPending}>
              <Pause />
              Pause
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => toggle.mutate(true)} loading={toggle.isPending}>
              <Play />
              Resume
            </Button>
          ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={!s.counts.include}
          loading={save.isPending}
          onClick={() => save.mutate(`${s.title} — included`)}
        >
          <FolderPlus />
          Save included as a collection
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={`/api/screenings/${id}/export`} download>
            <Download />
            Export CSV
          </a>
        </Button>
        <Button
          size="sm"
          variant="danger-ghost"
          className="ml-auto"
          onClick={() => confirm("Delete this screening?") && remove.mutate()}
        >
          <Trash2 />
          Delete
        </Button>
      </div>
      <div role="group" aria-label="Filter by decision" className="flex flex-wrap gap-1">
        {(["all", "include", "maybe", "exclude", "pending"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
            className={cn(
              "rounded-full border px-3 py-1 text-[13px]",
              filter === k
                ? "border-accent bg-accent-soft text-accent-text"
                : "border-border text-muted hover:text-text",
            )}
          >
            {k === "all" ? `All (${s.total})` : `${DECISION[k].label} (${s.counts[k]})`}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <Item key={item.paper.id} item={item} screeningId={id} />
        ))}
        {!items.length && <p className="py-6 text-center text-sm text-muted">Nothing here.</p>}
      </div>
    </div>
  );
}
