"use client";

import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/spinner";
import { api, errorMessage, qs } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { PublicationTrend } from "@/lib/types";

const percent = (g: number) => `${g >= 0 ? "+" : ""}${Math.round(g * 100)}%`;

/** "Papers per year" toggle for the search results header. */
export function TrendButton({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      title="How many papers matching this search were published each year"
    >
      <TrendingUp />
      Papers per year
    </Button>
  );
}

/** Bar chart of papers per year for a search (OpenAlex counts; no AI). */
export function TrendChart({ query }: { query: string }) {
  const trend = useQuery({
    queryKey: ["trend", query],
    queryFn: () => api<PublicationTrend>(`/api/search/trend${qs({ q: query })}`),
    staleTime: 60 * 60_000,
  });
  return (
    <section aria-label="Papers per year" className="rounded-xl border border-border bg-surface p-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <TrendingUp className="size-4 text-accent" aria-hidden />
        Papers per year
      </h2>
      {trend.isLoading && <Skeleton className="mt-3 h-28 w-full" />}
      {trend.error && (
        <p className="mt-2 text-[13px] text-muted">{errorMessage(trend.error, "Could not count the papers.")}</p>
      )}
      {trend.data && <Bars trend={trend.data} />}
    </section>
  );
}

function Bars({ trend }: { trend: PublicationTrend }) {
  const series = trend.series[0];
  if (!series) return null;
  const max = Math.max(1, ...series.counts);
  const total = series.counts.reduce((a, b) => a + b, 0);
  if (!total) return <p className="mt-2 text-[13px] text-muted">No papers match this search in these years.</p>;
  return (
    <>
      <p className="mt-0.5 text-[12.5px] text-muted">
        Matching the search in titles and abstracts (OpenAlex).
        {series.growth !== null && (
          <>
            {" "}
            <span className="font-medium text-text">{percent(series.growth)}</span> in the last three full years against
            the three before
            {series.shareGrowth !== null && <> ({percent(series.shareGrowth)} as a share of all papers)</>}.
          </>
        )}
      </p>
      <div className="mt-3 flex h-28 items-end gap-1" role="list">
        {trend.years.map((year, i) => {
          const n = series.counts[i];
          const partial = year === trend.partialYear;
          return (
            <div
              key={year}
              role="listitem"
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${year}${partial ? " (so far)" : ""}: ${n.toLocaleString("en-US")} papers`}
            >
              <div
                className={cn("w-full rounded-t bg-accent/70", partial && "bg-accent/30")}
                style={{ height: `${Math.max(2, (n / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1 text-[10.5px] text-subtle">
        {trend.years.map((year) => (
          <span key={year} className="min-w-0 flex-1 truncate text-center">
            <span className="hidden sm:inline">{year}</span>
            <span className="sm:hidden">’{String(year).slice(2)}</span>
            {year === trend.partialYear ? "*" : ""}
          </span>
        ))}
      </div>
      {trend.partialYear && <p className="mt-1 text-[11.5px] text-subtle">* {trend.partialYear} so far</p>}
    </>
  );
}
