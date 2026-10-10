/**
 * AI ranking of the papers a research reply cites: the papers to read first (in order) and a
 * high / medium / low priority for the rest, each with a short reason. One small extra AI call after
 * the reply is written; if it fails or returns nonsense, the list falls back to citation counts.
 */
import { z } from "zod";
import { SOURCE_PRIORITIES, type ResearchSource, type SourceRanking } from "@/lib/types";
import { complete, type AIProvider } from "@/server/ai/types";
import { citedKeys } from "./agent";

/** Steps that searched the literature: only replies with one of these are research results worth ranking. */
export const LITERATURE_STEP_KINDS = ["search", "references", "citations"] as const;

/** Replies citing fewer papers than this are not worth ranking. */
export const MIN_RANKED_PAPERS = 3;
const MAX_REPORT_CHARS = 60_000;

const SYSTEM = `You rank the papers a research report cites, for a researcher deciding what to read.
Return JSON only, in this shape:
{"start": [{"key": "P3", "why": "..."}], "priority": [{"key": "P5", "level": "high", "why": "..."}]}

- "start": 3-6 papers to read first, in reading order (foundations or the clearest overview before specialised work). If the report has a "Where to start reading" section, follow it.
- "priority": every other cited paper exactly once, with "level":
  - "high": central to answering the question — the report's argument relies on it (key methods, baselines, strongest evidence).
  - "medium": useful supporting evidence or a notable variant.
  - "low": background or a passing mention.
- "why": at most 15 words, specific to the question (what the paper contributes here), no praise.
- Use only the keys listed under <papers>. Judge from the report and the paper details; do not invent facts.`;

const rankingSchema = z.object({
  start: z.array(z.object({ key: z.string(), why: z.string().nullish() })).default([]),
  priority: z.array(z.object({ key: z.string(), level: z.string(), why: z.string().nullish() })).default([]),
});

function paperLine(s: ResearchSource) {
  const meta = [s.authors, s.year, s.venue, s.citationCount != null ? `${s.citationCount} citations` : null]
    .filter(Boolean)
    .join(" · ");
  return `${s.key}: ${s.title}${meta ? ` (${meta})` : ""}`;
}

/** The cited papers of a reply (notes are the user's own and are not ranked). */
export function citedPapers(content: string, sources: ResearchSource[]) {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  return citedKeys(content)
    .map((k) => byKey.get(k))
    .filter((s): s is ResearchSource => s?.type === "paper");
}

const tidy = (why: string | null | undefined) => {
  const t = (why ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > 160 ? `${t.slice(0, 159).trimEnd()}…` : t) : null;
};

/**
 * Validates the model's ranking against the cited papers: unknown and repeated keys are dropped, and
 * cited papers it left out are added as "medium" without a reason, so every cited paper appears once.
 */
export function parseRanking(raw: string, papers: ResearchSource[]): SourceRanking | null {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  let parsed: z.infer<typeof rankingSchema>;
  try {
    parsed = rankingSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
  const known = new Set(papers.map((p) => p.key));
  const seen = new Set<string>();
  const take = (key: string) => {
    const k = key.trim().toUpperCase();
    if (!known.has(k) || seen.has(k)) return null;
    seen.add(k);
    return k;
  };
  const start = parsed.start.slice(0, 8).flatMap((s) => {
    const key = take(s.key);
    return key ? [{ key, why: tidy(s.why) }] : [];
  });
  const priority = parsed.priority.flatMap((p) => {
    const key = take(p.key);
    const level = SOURCE_PRIORITIES.find((l) => l === p.level.toLowerCase().trim()) ?? "medium";
    return key ? [{ key, level, why: tidy(p.why) }] : [];
  });
  if (!start.length && !priority.length) return null;
  for (const p of papers) if (!seen.has(p.key)) priority.push({ key: p.key, level: "medium", why: null });
  return { start, priority };
}

/** Asks the model to rank a reply's cited papers; null when there is too little to rank or it fails. */
export async function rankCitedSources(
  provider: AIProvider,
  input: { question: string; content: string; sources: ResearchSource[]; signal?: AbortSignal },
): Promise<SourceRanking | null> {
  const papers = citedPapers(input.content, input.sources);
  if (papers.length < MIN_RANKED_PAPERS) return null;
  const report =
    input.content.length > MAX_REPORT_CHARS ? `${input.content.slice(0, MAX_REPORT_CHARS)}\n…` : input.content;
  const raw = await complete(provider, {
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<question>\n${input.question}\n</question>\n\n<report>\n${report}\n</report>\n\n<papers>\n${papers.map(paperLine).join("\n")}\n</papers>`,
      },
    ],
    signal: input.signal,
  });
  const ranking = parseRanking(raw, papers);
  return ranking && { ...ranking, provider: provider.kind, model: provider.model || null };
}
