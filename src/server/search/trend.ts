/**
 * Publication trends: papers per year for topics, from OpenAlex's grouped counts (no AI). The search page
 * charts them; the assistant's field analysis reads them as numbers.
 */
import type { PublicationTrend } from "@/lib/types";
import { scholarly } from "@/server/scholarly/service";

/** Years before the current one shown by default. */
const DEFAULT_SPAN = 10;
/** Fewer papers than this in the compared years make a growth figure meaningless. */
const MIN_PAPERS_FOR_GROWTH = 20;

/** Last three full years against the three before (0.5 = +50%). */
export function growth(values: number[], years: number[], partialYear: number | null): number | null {
  const full = values.filter((_, i) => years[i] !== partialYear);
  if (full.length < 6) return null;
  const recent = full.slice(-3).reduce((a, b) => a + b, 0);
  const before = full.slice(-6, -3).reduce((a, b) => a + b, 0);
  if (before + recent < MIN_PAPERS_FOR_GROWTH || before <= 0) return null;
  return recent / before - 1;
}

export async function publicationTrend(
  queries: string[],
  opts: { yearFrom?: number; yearTo?: number; now?: Date } = {},
): Promise<PublicationTrend> {
  const current = (opts.now ?? new Date()).getFullYear();
  const yearTo = Math.min(opts.yearTo ?? current, current);
  const yearFrom = Math.max(1900, Math.min(opts.yearFrom ?? current - DEFAULT_SPAN, yearTo));
  const years = Array.from({ length: yearTo - yearFrom + 1 }, (_, i) => yearFrom + i);
  const partialYear = yearTo === current ? current : null;
  const s = scholarly();
  const [all, ...perQuery] = await Promise.all([
    s.yearCounts(null, yearFrom, yearTo),
    ...queries.map((q) => s.yearCounts(q, yearFrom, yearTo)),
  ]);
  const allCounts = years.map((y) => all.get(y) ?? 0);
  return {
    years,
    all: allCounts,
    partialYear,
    series: queries.map((query, i) => {
      const counts = years.map((y) => perQuery[i].get(y) ?? 0);
      // Per million papers, so the literature's own growth does not count as the topic's.
      const share = counts.map((c, j) => (allCounts[j] ? (c / allCounts[j]) * 1e6 : 0));
      const g = growth(counts, years, partialYear);
      return { query, counts, growth: g, shareGrowth: g === null ? null : growth(share, years, partialYear) };
    }),
  };
}
