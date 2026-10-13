/**
 * The assistant loop. Paperweave runs it; the model only decides. Each round the model reads what has
 * been found so far and replies with JSON naming the next actions — reading the workspace, searching
 * the literature (when enabled), reading papers, or proposing workspace changes. Paperweave runs the
 * reading actions in parallel, validates proposed changes, and appends the results to the findings.
 * When the model is done (or the round budget is used up), it writes the reply, citing sources by key.
 * The protocol is plain text + JSON, so it works with every provider — API models, subscription CLIs
 * and local models alike.
 */
import { z } from "zod";
import { READING_STATUSES, type ProposedChange, type ResearchMode, type ResearchStepKind } from "@/lib/types";
import type { AIProvider } from "@/server/ai/types";
import { AIError, complete, lowContext, readsImages } from "@/server/ai/types";
import { ScholarlyUnavailableError } from "@/server/scholarly/service";
import { CHANGE_TOOLS, changeActionSchema, proposeChange, type ChangeAction } from "./changes";
import { compareVersions, viewPage } from "./document-tools";
import { calculate, findResources, readResource } from "./resource-tools";
import { extractFields, findPassages } from "./evidence-tools";
import { findPlaybook, playbookIndex } from "./playbooks";
import {
  findSavedPapers,
  paperInfo,
  readConcept,
  readHighlights,
  readNewPapers,
  readReviews,
  readScreening,
  relatedInLibrary,
  suggestPlacement,
  SAVED_SORTS,
} from "./workspace-tools";
import {
  citationNeighbors,
  existingConcepts,
  listWorkspace,
  paperLine,
  publicationTrendTool,
  readNote,
  readPaper,
  searchArxiv,
  searchLibrary,
  searchPapers,
  ToolInputError,
  type SourceRegistry,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from "./tools";

export const LIMITS: Record<ResearchMode, { rounds: number; actionsPerRound: number; totalActions: number }> = {
  chat: { rounds: 4, actionsPerRound: 8, totalActions: 24 },
  search: { rounds: 4, actionsPerRound: 8, totalActions: 24 },
  deep: { rounds: 6, actionsPerRound: 8, totalActions: 40 },
  field: { rounds: 10, actionsPerRound: 10, totalActions: 80 },
};

/** Tools that reach outside the workspace; only available when literature search is on. */
const LITERATURE_TOOLS = new Set(["search_papers", "search_arxiv", "references", "citations", "publication_trend"]);

const MAX_FINDINGS_CHARS = 100_000;
const MAX_SOURCE_LINES = 150;

/**
 * What the assistant gives the model. Claude, GPT and local models set to "full" context get everything; a
 * local model set to "low" gets the core tools only, no playbooks and smaller budgets; models that cannot
 * read images do not get view_page.
 */
export interface AssistantProfile {
  low: boolean;
  images: boolean;
}

const FULL_PROFILE: AssistantProfile = { low: false, images: true };

/** Smaller budgets for low context: fewer rounds and actions, so findings stay short. */
export const LOW_LIMITS: Record<ResearchMode, { rounds: number; actionsPerRound: number; totalActions: number }> = {
  chat: { rounds: 3, actionsPerRound: 4, totalActions: 10 },
  search: { rounds: 3, actionsPerRound: 4, totalActions: 10 },
  deep: { rounds: 4, actionsPerRound: 5, totalActions: 18 },
  field: { rounds: 5, actionsPerRound: 5, totalActions: 24 },
};

/** The core tools offered at low context: finding, reading and organizing papers. */
export const LOW_CONTEXT_TOOLS = new Set([
  "search_library",
  "find_saved_papers",
  "list_workspace",
  "paper_info",
  "read_paper",
  "find_passages",
  "list_concepts",
  "read_concept",
  "read_note",
  "suggest_placement",
  "search_papers",
  "search_arxiv",
  "references",
  "citations",
  "publication_trend",
  "save_papers",
  "set_reading_status",
  "create_collection",
  "add_to_collection",
  "remove_from_collection",
  "tag_papers",
  "create_concept",
  "link_concept",
  "unlink_concept",
  "create_note",
  "append_to_note",
]);

/** Whether the profile offers a tool. */
export function offersTool(profile: AssistantProfile, tool: string) {
  if (tool === "view_page" && !profile.images) return false;
  return !profile.low || LOW_CONTEXT_TOOLS.has(tool);
}

const LOW_BUDGET = { findingsChars: 30_000, sourceLines: 60, turns: 2, answerChars: 1500 };

const limitsFor = (state: Pick<ResearchState, "mode" | "profile">) =>
  (state.profile?.low ? LOW_LIMITS : LIMITS)[state.mode];

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const key = z
  .string()
  .trim()
  .regex(/^[PNpn]\d{1,4}$/);
const year = z.coerce.number().int().min(1000).max(3000).optional().catch(undefined);
const offset = z.coerce.number().int().min(0).max(5000).optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
const names = z
  .union([z.string().trim().min(1).max(120), z.array(z.string().trim().min(1).max(120)).max(10)])
  .optional()
  .catch(undefined);
const PUBLICATION_TYPES = [
  "journal_article",
  "conference",
  "preprint",
  "review",
  "book",
  "dataset",
  "dissertation",
  "other",
] as const;
const types = z.array(z.enum(PUBLICATION_TYPES)).max(8).optional().catch(undefined);

const readActionSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("search_papers"),
    query: z.string().trim().min(2).max(300),
    year_from: year,
    year_to: year,
    min_citations: z.coerce.number().int().min(0).optional().catch(undefined),
    sort: z.enum(["relevance", "newest", "citations"]).optional().catch(undefined),
    source: z.enum(["general", "biomedical", "openreview"]).optional().catch(undefined),
    under_review: flag,
    offset,
  }),
  z.object({ tool: z.literal("search_arxiv"), query: z.string().trim().min(2).max(300) }),
  z.object({
    tool: z.literal("publication_trend"),
    queries: z.array(z.string().trim().min(2).max(200)).min(1).max(6),
    year_from: year,
    year_to: year,
  }),
  z.object({
    tool: z.literal("references"),
    paper: key,
    offset,
    sort: z.enum(["cited", "newest"]).optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("citations"),
    paper: key,
    offset,
    sort: z.enum(["cited", "newest"]).optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("read_paper"),
    paper: key,
    focus: z.string().trim().max(300).optional(),
    /** A page range such as "5-8" (at most 8 pages). */
    pages: z
      .string()
      .trim()
      .regex(/^\d{1,4}(\s*[-–]\s*\d{1,4})?$/)
      .optional()
      .catch(undefined),
  }),
  z.object({
    tool: z.literal("search_library"),
    query: z.string().trim().min(2).max(300),
    kind: z.enum(["papers", "notes", "highlights", "pdf_text"]).optional().catch(undefined),
    offset,
  }),
  z.object({ tool: z.literal("read_note"), note: key }),
  z.object({ tool: z.literal("list_workspace") }),
  z.object({ tool: z.literal("list_concepts") }),
  z.object({ tool: z.literal("read_concept"), concept: z.string().trim().min(1).max(120) }),
  z.object({ tool: z.literal("paper_info"), paper: key }),
  z.object({
    tool: z.literal("find_saved_papers"),
    collection: names,
    tag: names,
    concept: names,
    not_collection: names,
    not_tag: names,
    not_concept: names,
    status: z
      .union([z.enum(READING_STATUSES), z.array(z.enum(READING_STATUSES)).max(4)])
      .optional()
      .catch(undefined),
    query: z.string().trim().max(300).optional(),
    year_from: year,
    year_to: year,
    has_pdf: flag,
    has_notes: flag,
    has_highlights: flag,
    has_concepts: flag,
    in_collection: flag,
    types,
    not_types: types,
    sort: z.enum(SAVED_SORTS).optional().catch(undefined),
    abstracts: flag,
    offset,
    limit: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
  }),
  z.object({ tool: z.literal("read_highlights"), paper: key, offset }),
  z.object({ tool: z.literal("related_in_library"), paper: key }),
  z.object({ tool: z.literal("suggest_placement"), papers: z.array(key).min(1).max(20) }),
  z.object({ tool: z.literal("open_playbook"), name: z.string().trim().min(1).max(60) }),
  z.object({
    tool: z.literal("find_passages"),
    queries: z.array(z.string().trim().min(2).max(200)).min(1).max(6),
    papers: z.array(key).max(10).optional().catch(undefined),
    limit: z.coerce.number().int().min(1).max(15).optional().catch(undefined),
  }),
  z.object({ tool: z.literal("find_resources"), paper: key }),
  z.object({ tool: z.literal("read_screening"), title: z.string().trim().max(200).optional() }),
  z.object({ tool: z.literal("read_new_papers"), search: z.string().trim().max(300).optional() }),
  z.object({ tool: z.literal("read_reviews"), paper: key }),
  z.object({
    tool: z.literal("read_resource"),
    url: z.string().trim().url().max(500),
    path: z.string().trim().max(300).optional(),
  }),
  z.object({
    tool: z.literal("calculate"),
    expression: z.string().trim().min(1).max(500),
    label: z.string().trim().max(200).optional(),
  }),
  z.object({
    tool: z.literal("view_page"),
    paper: key,
    page: z.coerce.number().int().min(1).max(10_000),
    question: z.string().trim().max(500).optional(),
  }),
  z.object({
    tool: z.literal("compare_versions"),
    paper: key,
    from: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
    to: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
  }),
  z.object({
    tool: z.literal("extract_fields"),
    papers: z.array(key).min(1).max(8),
    fields: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  }),
]);
type ReadAction = z.infer<typeof readActionSchema>;

/** Every reading tool the assistant has (with CHANGE_TOOLS: all its tools). */
export const READ_TOOLS = new Set<string>(readActionSchema.options.map((o) => o.shape.tool.value));
export type ResearchAction = ReadAction | ChangeAction;

const actionSchema = z.union([readActionSchema, changeActionSchema]);

export interface RoundDecision {
  thought: string;
  actions: ResearchAction[];
  done: boolean;
}

/** Extracts the decision from a model reply; invalid actions are dropped rather than failing. */
export function parseDecision(text: string): RoundDecision | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { thought?: unknown; actions?: unknown; done?: unknown };
  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .map((a) => actionSchema.safeParse(a))
    .filter((r) => r.success)
    .map((r) => r.data);
  return {
    thought: typeof obj.thought === "string" ? obj.thought.trim().slice(0, 1200) : "",
    actions,
    done: obj.done === true || actions.length === 0,
  };
}

const isChange = (a: ResearchAction): a is ChangeAction => CHANGE_TOOLS.has(a.tool);

/** A canonical form used to skip actions that were already taken. */
function actionId(a: ResearchAction) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  switch (a.tool) {
    case "search_papers":
      return `search:${a.source ?? ""}:${norm(a.query)}:${a.year_from ?? ""}:${a.year_to ?? ""}:${a.min_citations ?? ""}:${a.sort ?? ""}:${a.offset ?? 0}`;
    case "search_arxiv":
      return `arxiv:${norm(a.query)}`;
    case "publication_trend":
      return `trend:${a.queries.map(norm).join("|")}:${a.year_from ?? ""}:${a.year_to ?? ""}`;
    case "search_library":
      return `library:${norm(a.query)}:${a.kind ?? ""}:${a.offset ?? 0}`;
    case "read_paper":
      return `read:${a.paper.toUpperCase()}:${norm(a.focus ?? "")}:${(a.pages ?? "").replace(/\s/g, "")}`;
    case "list_concepts":
      return "concepts";
    case "read_concept":
      return `concept:${norm(a.concept)}`;
    case "paper_info":
    case "related_in_library":
      return `${a.tool}:${a.paper.toUpperCase()}`;
    case "read_highlights":
      return `${a.tool}:${a.paper.toUpperCase()}:${a.offset ?? 0}`;
    case "suggest_placement":
      return `placement:${a.papers.map((k) => k.toUpperCase()).join(",")}`;
    case "find_saved_papers":
      return `find:${JSON.stringify(a)}`;
    case "open_playbook":
      return `playbook:${norm(a.name)}`;
    case "find_passages":
      return `passages:${a.queries.map(norm).sort().join("|")}:${(a.papers ?? []).map((k) => k.toUpperCase()).join(",")}`;
    case "find_resources":
      return `resources:${a.paper.toUpperCase()}`;
    case "read_screening":
      return `screening:${norm(a.title ?? "")}`;
    case "read_new_papers":
      return `new-papers:${norm(a.search ?? "")}`;
    case "read_reviews":
      return `reviews:${a.paper.toUpperCase()}`;
    case "read_resource":
      return `resource:${a.url}:${a.path ?? ""}`;
    case "calculate":
      return `calc:${a.expression.replace(/\s/g, "")}`;
    case "view_page":
      return `view:${a.paper.toUpperCase()}:${a.page}:${norm(a.question ?? "")}`;
    case "compare_versions":
      return `versions:${a.paper.toUpperCase()}:${a.from ?? ""}:${a.to ?? ""}`;
    case "extract_fields":
      return `extract:${a.papers.map((k) => k.toUpperCase()).join(",")}:${a.fields.map(norm).join("|")}`;
    case "read_note":
      return `note:${a.note.toUpperCase()}`;
    case "list_workspace":
      return "workspace";
    case "references":
    case "citations":
      return `${a.tool}:${a.paper.toUpperCase()}:${a.sort ?? ""}:${a.offset ?? 0}`;
    default:
      return `change:${JSON.stringify(a)}`;
  }
}

function describeRead(a: ReadAction, sources: SourceRegistry): { kind: ResearchStepKind; label: string } {
  const title = (k: string) => {
    const s = sources.get(k);
    return s ? `“${s.title.length > 70 ? `${s.title.slice(0, 70)}…` : s.title}”` : k;
  };
  switch (a.tool) {
    case "search_papers": {
      const years = a.year_from || a.year_to ? ` (${a.year_from ?? "…"}–${a.year_to ?? "now"})` : "";
      const order = a.sort === "newest" ? ", newest first" : a.sort === "citations" ? ", most cited first" : "";
      const where =
        a.source === "biomedical"
          ? "the biomedical literature (PubMed / Europe PMC)"
          : a.source === "openreview"
            ? "ML venues on OpenReview"
            : "the literature";
      return { kind: "search", label: `Searched ${where} for “${a.query}”${years}${order}` };
    }
    case "search_arxiv":
      return { kind: "search", label: `Checked arXiv for the newest preprints on “${a.query}”` };
    case "publication_trend":
      return { kind: "trend", label: `Counted papers per year on ${a.queries.map((q) => `“${q}”`).join(", ")}` };
    case "references":
      return { kind: "references", label: `Followed the references of ${title(a.paper)}` };
    case "citations":
      return { kind: "citations", label: `Found papers citing ${title(a.paper)}` };
    case "read_paper":
      return {
        kind: "read",
        label: `Read ${a.pages ? `pages ${a.pages.replace(/\s/g, "").replace("-", "–")} of ` : ""}${title(a.paper)}${a.focus ? ` — ${a.focus}` : ""}`,
      };
    case "list_concepts":
      return { kind: "workspace", label: "Looked at your existing concepts" };
    case "read_concept":
      return { kind: "workspace", label: `Looked up your concept “${a.concept}”` };
    case "paper_info":
      return { kind: "workspace", label: `Checked where ${title(a.paper)} sits in your workspace` };
    case "find_saved_papers": {
      const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(" or ") : v);
      const no = (v: boolean | undefined, what: string) =>
        v === false ? `without ${what}` : v ? `with ${what}` : null;
      const what = [
        a.collection && `in “${list(a.collection)}”`,
        a.tag && `tagged #${list(a.tag)}`,
        a.concept && `linked to “${list(a.concept)}”`,
        a.not_collection && `not in “${list(a.not_collection)}”`,
        a.status && `marked ${list(a.status)}`,
        a.query && `matching “${a.query}”`,
        no(a.has_notes, "notes"),
        no(a.has_highlights, "highlights"),
        no(a.has_pdf, "a PDF"),
        a.not_types && `excluding ${a.not_types.join(", ")}`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        kind: "library",
        label: `Listed your saved papers${what ? ` ${what}` : ""}${a.offset ? ` (from no. ${a.offset + 1})` : ""}`,
      };
    }
    case "read_highlights":
      return { kind: "read", label: `Read your highlights in ${title(a.paper)}` };
    case "related_in_library":
      return { kind: "library", label: `Found papers in your library connected to ${title(a.paper)}` };
    case "suggest_placement":
      return { kind: "library", label: `Looked for where ${a.papers.map(title).join(", ")} could go` };
    case "open_playbook":
      return { kind: "playbook", label: `Opened the “${findPlaybook(a.name)?.title ?? a.name}” playbook` };
    case "find_passages": {
      const where = a.papers?.length ? ` in ${a.papers.map(title).join(", ")}` : " in your PDFs";
      return { kind: "read", label: `Looked for passages about ${a.queries.map((q) => `“${q}”`).join(" / ")}${where}` };
    }
    case "read_screening":
      return { kind: "workspace", label: a.title ? `Read your screening “${a.title}”` : "Looked at your screenings" };
    case "read_new_papers":
      return {
        kind: "workspace",
        label: a.search ? `Read the new papers for “${a.search}”` : "Looked at the topics you follow (New papers)",
      };
    case "read_reviews":
      return { kind: "read", label: `Read the OpenReview reviews of ${title(a.paper)}` };
    case "find_resources":
      return { kind: "search", label: `Looked for the code, data and models of ${title(a.paper)}` };
    case "read_resource": {
      let where = a.url;
      try {
        const u = new URL(a.url);
        where = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
      } catch {
        /* shown as given */
      }
      return { kind: "read", label: `Read ${where}${a.path ? ` → ${a.path}` : ""}` };
    }
    case "calculate":
      return { kind: "workspace", label: `Calculated ${a.label ?? a.expression}` };
    case "view_page":
      return {
        kind: "read",
        label: `Looked at page ${a.page} of ${title(a.paper)}${a.question ? ` — ${a.question}` : ""}`,
      };
    case "compare_versions":
      return {
        kind: "read",
        label: `Compared ${a.from ? `v${a.from}` : "the previous version"} with ${a.to ? `v${a.to}` : "the newest"} of ${title(a.paper)}`,
      };
    case "extract_fields":
      return {
        kind: "read",
        label: `Extracted ${a.fields.join(", ")} from ${a.papers.length === 1 ? title(a.papers[0]) : `${a.papers.length} papers`}`,
      };
    case "search_library":
      return { kind: "library", label: `Searched your library for “${a.query}”` };
    case "read_note":
      return { kind: "note", label: `Read your note ${title(a.note)}` };
    case "list_workspace":
      return { kind: "workspace", label: "Looked at your library, collections, tags and concepts" };
  }
}

export function toolFor(a: ReadAction, sources: SourceRegistry): ToolSpec {
  const { kind, label } = describeRead(a, sources);
  const run = async (ctx: ToolContext): Promise<ToolResult> => {
    switch (a.tool) {
      case "search_papers":
        return searchPapers(ctx, {
          query: a.query,
          yearFrom: a.year_from,
          yearTo: a.year_to,
          minCitations: a.min_citations,
          sort: a.sort,
          source: a.source,
          offset: a.offset,
          underReview: a.under_review,
        });
      case "search_arxiv":
        return searchArxiv(ctx, a.query);
      case "publication_trend":
        return publicationTrendTool({ queries: a.queries, yearFrom: a.year_from, yearTo: a.year_to });
      case "references":
      case "citations":
        return citationNeighbors(ctx, a.paper, a.tool, { offset: a.offset, sort: a.sort });
      case "read_paper":
        return readPaper(ctx, a.paper, a.focus, a.pages);
      case "search_library":
        return searchLibrary(ctx, a.query, { kind: a.kind, offset: a.offset });
      case "read_note":
        return readNote(ctx, a.note);
      case "list_workspace":
        return listWorkspace(ctx);
      case "list_concepts":
        return existingConcepts(ctx);
      case "read_concept":
        return readConcept(ctx, a.concept);
      case "paper_info":
        return paperInfo(ctx, a.paper);
      case "find_saved_papers":
        return findSavedPapers(ctx, {
          collection: a.collection,
          tag: a.tag,
          concept: a.concept,
          notCollection: a.not_collection,
          notTag: a.not_tag,
          notConcept: a.not_concept,
          status: a.status,
          query: a.query,
          yearFrom: a.year_from,
          yearTo: a.year_to,
          hasPdf: a.has_pdf,
          hasNotes: a.has_notes,
          hasHighlights: a.has_highlights,
          hasConcepts: a.has_concepts,
          inCollection: a.in_collection,
          types: a.types,
          notTypes: a.not_types,
          sort: a.sort,
          abstracts: a.abstracts,
          offset: a.offset,
          limit: a.limit,
        });
      case "read_highlights":
        return readHighlights(ctx, a.paper, a.offset);
      case "related_in_library":
        return relatedInLibrary(ctx, a.paper);
      case "suggest_placement":
        return suggestPlacement(ctx, a.papers);
      case "find_passages":
        return findPassages(ctx, { queries: a.queries, papers: a.papers, limit: a.limit });
      case "extract_fields":
        return extractFields(ctx, { papers: a.papers, fields: a.fields });
      case "find_resources":
        return findResources(ctx, a.paper);
      case "read_screening":
        return readScreening(ctx, a.title);
      case "read_new_papers":
        return readNewPapers(ctx, a.search);
      case "read_reviews":
        return readReviews(ctx, a.paper);
      case "read_resource":
        return readResource(ctx, { url: a.url, path: a.path });
      case "calculate":
        return calculate({ expression: a.expression, label: a.label });
      case "view_page":
        return viewPage(ctx, { paper: a.paper, page: a.page, question: a.question });
      case "compare_versions":
        return compareVersions(ctx, { paper: a.paper, from: a.from, to: a.to });
      case "open_playbook": {
        const playbook = findPlaybook(a.name);
        if (!playbook) throw new ToolInputError(`There is no playbook named “${a.name}”.`);
        return { report: `Playbook “${playbook.title}” — follow it with judgment:\n${playbook.steps}` };
      }
    }
  };
  return { kind, label, run };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** The planner's instructions, without the tools and playbooks the profile leaves out. */
export function agentSystem(mode: ResearchMode, profile: AssistantProfile = FULL_PROFILE) {
  let system = fullAgentSystem(mode);
  if (profile.low || !profile.images) {
    system = system
      .split("\n")
      .filter((line) => {
        const tool = /^- \{"tool": "(\w+)"/.exec(line)?.[1];
        return !tool || offersTool(profile, tool);
      })
      .join("\n");
  }
  if (profile.low) {
    // No playbooks: the section from its heading up to the guidelines goes.
    system = system
      .replace(/\n\nPlaybooks — [\s\S]*?\n\nGuidelines:/, "\n\nGuidelines:")
      // Its tools are all left out at low context.
      .replace(/\nDeleting — [^\n]*/, "");
  }
  return system;
}

function fullAgentSystem(mode: ResearchMode) {
  const literature =
    mode === "chat"
      ? ""
      : `
- {"tool": "search_papers", "query": "...", "year_from": 2019, "year_to": 2024, "min_citations": 50, "sort": "newest", "source": "general", "offset": 10} — search the scholarly literature (10 results per call; "offset" pages further). Filters, sort and source are optional; sort is "relevance" (default), "newest" or "citations". source is "general" (default: Semantic Scholar / OpenAlex, every field), "biomedical" (Europe PMC: PubMed, PubMed Central, medRxiv/bioRxiv — use for clinical and life-science topics; supports newest and citations sorting) or "openreview" (ML venues such as ICLR, NeurIPS, ICML, with accept/reject status in the venue; no citation counts; papers still under double-blind review are left out unless "under_review": true — they are anonymous and have no free PDF). Use precise field terminology; vary phrasings and sub-topics instead of repeating a query.
- {"tool": "search_arxiv", "query": "..."} — the most recently posted arXiv preprints matching all query words (days old; often not yet in the other databases). Use it when the user wants the latest work.
- {"tool": "publication_trend", "queries": ["<topic>", "<sub-area>", ...], "year_from": 2015} — how many papers were published each year on up to 6 topics (titles and abstracts; default: the last 10 years), against all papers, with growth figures. Use it for claims about growth or decline instead of guessing; give queries of similar breadth, as a researcher would phrase the topic.
- {"tool": "references", "paper": "P3"} — the papers P3 cites (foundational, earlier work).
- {"tool": "citations", "paper": "P3", "sort": "newest"} — papers that cite P3 (follow-up and recent work). Both list 15 at a time, most cited first or "sort": "newest"; "offset" pages further.`;
  const modeGuide =
    mode === "chat"
      ? `Literature search is OFF: you can use the user's workspace and papers already in <sources>, but not search for new papers. If the user needs papers you cannot find there, finish; the reply will suggest turning on literature search.`
      : mode === "search"
        ? `Literature search is ON: search the scholarly literature when the request needs papers beyond the workspace. Stay focused (1-3 rounds).`
        : mode === "deep"
          ? `Deep research: be thorough. Start broad (2-4 searches covering different angles), then go deep — identify the most cited/seminal papers (sort "citations") and the newest strong papers (sort "newest", plus search_arxiv for the very latest), follow references for foundations and citations for recent progress, and read the papers that matter most before finishing. Use several rounds.`
          : FIELD_GUIDE;
  return `# Paperweave assistant
You are the planning half of an AI assistant inside a scientific knowledge workspace: the user's papers (library), collections, tags, concepts, notes and PDF highlights. You do not write the reply yourself: you decide which actions to take next. Paperweave runs them and shows you the results in the next round; afterwards a separate step writes the reply.

Reply with a single JSON object and nothing else:
{"thought": "<1-3 sentences: what you know so far and why you take these actions>", "actions": [<action>, ...]}
When you have what you need (or nothing needs doing, e.g. a greeting), reply instead:
{"thought": "<why>", "done": true}

Reading actions (refer to papers and notes only by the keys shown in <sources>, e.g. "P3", "N1"):
- {"tool": "search_library", "query": "...", "kind": "pdf_text", "offset": 20} — the user's saved papers, notes, highlights, PDF text and concepts (the best few of each). With "kind" (papers, notes, highlights or pdf_text) it lists 20 of that kind; "offset" pages further.
- {"tool": "find_passages", "queries": ["<phrasing>", "<synonym or the paper's own term>", ...], "papers": ["P3", "P5"]} — the passages that discuss something, best first, with page numbers and the surrounding sentences. With "papers": in their full text (also open-access copies); without: across every PDF in the user's library ("I remember a paper about…"). Give 2-4 phrasings, since papers word things differently.
- {"tool": "extract_fields", "papers": ["P1", "P2", "P3"], "fields": ["dataset", "evaluation metric", "main result", "compute"]} — the same facts from each paper (up to 8 papers, 10 fields) as a table, each value with its page and a supporting quote, or "not reported". Use it to compare papers on equal terms.
- {"tool": "view_page", "paper": "P3", "page": 6, "question": "what does Figure 3 show; what do the dashed arrows mean?"} — look at a page as an image: figures, plots, tables, diagrams and equations as laid out (read_paper only gives the text). Find the page first (read_paper, find_passages for "Figure 3", or <reader>).
- {"tool": "compare_versions", "paper": "P3", "from": 1, "to": 3} — what changed in the text between two arXiv versions (default: the previous version against the newest), with pages.
- {"tool": "find_resources", "paper": "P3"} — the paper's code, datasets, models, demos and project page: links in its own text (likely official) and repositories listed on Hugging Face for it.
- {"tool": "read_resource", "url": "https://github.com/owner/repo", "path": "configs/train.yaml"} — read a repository (overview, README, top-level files; one file with "path"), a Hugging Face model or dataset card, or a web page.
- {"tool": "calculate", "expression": "7e9 * 2 / 1e9", "label": "fp16 weights in GB"} — exact arithmetic (+ - * / ^ %, parentheses, sqrt, log, ln, exp, min, max, round, ceil, floor; 4k/3M/2G/1T suffixes). Use it instead of doing sums in your head; state the inputs and where they come from.
- {"tool": "read_screening", "title": "..."} — the user's screenings (systematic-review style): without a title, each with its progress; with one, its criteria and the included and "maybe" papers with reasons.
- {"tool": "read_new_papers", "search": "<a followed query>"} — New papers: without "search", the topics the user follows with how many new papers each has; with one, its papers (new first, with keys and abstracts) so you can rank them against the library, save the good ones or stop following stale topics.
- {"tool": "read_reviews", "paper": "P3"} — P3's OpenReview record: venue, accept/reject decision and the reviewers' ratings and summaries (reviews need an OpenReview account on the server; the decision does not).
- {"tool": "list_workspace"} — the user's saved papers (with keys), collections, tags and concepts.
- {"tool": "read_paper", "paper": "P3", "focus": "what to look for", "pages": "5-8"} — P3's full text where available (the user's PDF, its open-access PDF, or PubMed Central): the pages matching "focus", or the page range in "pages" (at most 8 pages; the paper's page count is reported). Both are optional.
- {"tool": "list_concepts"} — the user's existing concepts and how many papers each links.
- {"tool": "read_concept", "concept": "<name>"} — one concept: its description, every paper linked to it (with keys), related concepts, notes that mention it.
- {"tool": "paper_info", "paper": "P3"} — P3 in the user's workspace: reading status, collections, tags, concepts, notes on it (with keys), highlights, PDF.
- {"tool": "find_saved_papers", "collection": "A" or ["A", "B"], "tag": ..., "concept": ..., "not_collection": ..., "not_tag": ..., "not_concept": ..., "status": "saved" or ["saved", "reading"], "query": "...", "year_from": 2020, "year_to": 2025, "has_pdf": true, "has_notes": false, "has_highlights": false, "has_concepts": false, "in_collection": false, "types": ["review"], "not_types": ["review"], "sort": "updated|added|newest|oldest|citations|title", "abstracts": true, "offset": 0, "limit": 60} — the user's saved papers matching ALL given filters (each optional; a list means any of them; has_…/in_collection false finds what is missing, e.g. unread papers without notes). Reports the total; page with "offset" (up to 100 per call). With "abstracts": true each paper also shows the start of its abstract — use it whenever you judge what papers are about (organizing, grouping, linking concepts) rather than guessing from titles. Types: journal_article, conference, preprint, review (surveys), book, dataset, dissertation, other.
- {"tool": "read_highlights", "paper": "P3"} — the user's highlights and comments on P3, by page ("offset" pages past 120).
- {"tool": "related_in_library", "paper": "P3"} — saved papers connected to P3 through concepts, collections, citations or notes, strongest first.
- {"tool": "suggest_placement", "papers": ["P3"]} — where papers could go: existing collections and concepts hinted by concept names and citations, each paper's abstract, and where it already is.
- {"tool": "open_playbook", "name": "..."} — a step-by-step guide for a kind of task (see Playbooks).
- {"tool": "read_note", "note": "N2"} — one of the user's notes, as numbered blocks [B1], [B2], … (needed before edit_note).${literature}

Change actions — these are only proposed: the user reviews and applies them (unless they enabled auto-apply). Propose changes only when the user asks for them (saving, organizing, tagging, linking concepts, writing a note), never merely to answer a question:
- {"tool": "save_papers", "papers": ["P1", "P2"], "status": "reading"} — status is optional: saved, reading, read or archived. Its result lists hints for where each paper may belong.
- {"tool": "create_collection", "name": "...", "description": "...", "papers": ["P1", ...]}
- {"tool": "add_to_collection", "collection": "<existing collection name>", "papers": [...]}
- {"tool": "tag_papers", "tags": ["..."], "papers": [...]}
- {"tool": "create_concept", "name": "...", "description": "<one sentence>", "papers": [...], "priority": "high|medium|low", "why": "<one line>", "related": ["<broader concept name>"]} — a research topic the papers share (data or modality, method family, task, theory). "priority": how useful it is for connecting the library (high: links many papers, across collections). "related" is optional: broader concepts this one belongs under.
- {"tool": "link_concept", "concept": "<existing concept name>", "papers": [...], "priority": "high|medium|low", "why": "<one line>"}
- {"tool": "create_note", "title": "...", "content": "<Markdown; cite papers as [P1]>", "paper": "P1"} — "paper" is optional and makes it a note on that paper.
- {"tool": "attach_pdfs", "papers": [...]} — add the papers' legal open-access PDFs (read live from their source).
- {"tool": "set_reading_status", "papers": [...], "status": "saved|reading|read|archived"} — for papers already saved.
- {"tool": "remove_from_collection", "collection": "<name>", "papers": [...]}
- {"tool": "unlink_concept", "concept": "<name>", "papers": [...]}
- {"tool": "relate_concepts", "concept": "<name>", "related": ["<name>", ...]} — connect existing (or just proposed) concepts.
- {"tool": "append_to_note", "note": "N2", "content": "<Markdown; cite papers as [P1]>"} — add to the end of one of the user's notes.
- {"tool": "link_note", "note": "N2", "paper": "P1", "links": ["P3", "P4"]} — for an existing note: "paper" attaches it to that paper (it is then listed with that paper's own notes; a note belongs to at most one paper), "links" adds links to more papers (it then appears on their pages too). Either is optional.
- {"tool": "edit_note", "note": "N2", "edits": [{"op": "replace", "block": 3, "content": "<Markdown>"}, {"op": "delete", "block": 5}, {"op": "insert", "block": 2, "content": "<Markdown>"}]} — change an existing note (read_note first; "block" is the [B…] number; insert goes after that block, 0 = at the start). Untouched blocks stay exactly as they are. Keep the user's own wording, comments and [[links]] unless they asked to change them; the user sees each block before and after.
- {"tool": "merge_concepts", "into": "<concept to keep>", "from": ["<duplicate>", ...]} — the duplicates' papers, related concepts and note links move to "into", their names become its aliases, and they are deleted.
- {"tool": "rename_concept", "concept": "<current name>", "name": "<new name>"} — the old name stays as an alias.
- {"tool": "start_screening", "title": "...", "criteria": "Include: …\nExclude: …", "collection": "<collection name>", "papers": ["P1", ...], "use_full_text": false} — screen many papers (a collection and/or keys, up to 500) against inclusion / exclusion criteria in the background; each gets include / exclude / maybe with a reason the user can override.
- {"tool": "save_search", "query": "...", "source": "general|biomedical|openreview|arxiv"} — follow a topic: the search runs daily and new papers appear under New papers ("arxiv": the newest preprints). For "tell me when new papers on X appear".
- {"tool": "add_highlight", "paper": "P3", "text": "<exact words from the paper>", "page": 5, "comment": "...", "color": "yellow|green|blue|pink|purple"} — highlight a passage in the paper's PDF (it must have one here). Quote the text exactly as written (from read_paper or find_passages); "page", "comment" and "color" are optional.
- {"tool": "edit_collection", "collection": "<name>", "name": "<new name>", "description": "..."} — rename a collection and/or change its description (each optional).
- {"tool": "untag_papers", "tags": ["..."], "papers": [...]} — remove tags from papers.
- {"tool": "rename_tag", "tag": "<name>", "name": "<new name>"}
- {"tool": "edit_concept", "concept": "<name>", "description": "<one sentence>"} — rewrite a concept's description (rename_concept renames it).
Deleting — only when the user asked to delete or remove something; never as a side effect of organizing (these are never applied automatically, and all can be undone):
- {"tool": "delete_collection", "collection": "<name>"} — deletes the collection; its papers stay in the library.
- {"tool": "delete_tag", "tag": "<name>"} — deletes the tag and removes it from every paper.
- {"tool": "delete_concept", "concept": "<name>"} — deletes the concept and its links. For duplicates, merge_concepts instead.
- {"tool": "remove_from_library", "papers": [...]} — takes papers out of the library (and its collections and tags); their notes, highlights and PDFs are kept.
- {"tool": "stop_following", "query": "<a followed query>"} — stop a New papers search (read_new_papers lists them).

Playbooks — when a request matches one, open it first (in the same round as your first reading actions) and follow it with judgment; for anything else, decide the steps yourself:
${playbookIndex()}

Guidelines:
- ${modeGuide}
- To act on papers the user names or describes, first find them (search_library${mode === "chat" ? "" : " or search_papers"}) so they have keys.
- Check what exists (list_workspace, list_concepts) before creating collections, tags or concepts, so existing ones are reused.
- Adding papers to the library goes in steps, so the user can check each one:
  1. Know which papers. One paper the user names or describes: find it (search_library${mode === "chat" ? "" : ", then search_papers"}); if nothing matches, or several papers could be the one, propose nothing: the reply says what was found and asks which. Several papers the user names (titles, DOIs or arXiv ids; a DOI or id as the query finds that exact paper): find each the same way, in parallel; save the ones clearly found and leave out the rest — the reply goes through them one by one. Papers described only by topic ("add some papers on X"): search, but unless the user said which or how many ("the 5 most cited since 2022"), propose nothing — the reply lists the best candidates and asks which to add. Papers from an earlier reply ("the high-priority ones", "P3 and P5", "the first three"): take them from <conversation_so_far> and its <ranking> ("high priority" means the papers to read first and those ranked high). Papers the user says they just saved: find_saved_papers with "sort": "added" (it shows when each was added) — the group added most recently, preferring papers listed in <sources>; ask if it is unclear.
  2. Propose save_papers for those not saved yet.
  3. If the request also asks for collections or concepts, place the papers now (step 4). Otherwise do not: the reply asks whether to add them to collections and concepts, and you place them once the user agrees ("yes", "do it").
  4. Placing: suggest_placement for the papers (up to 20 per call) and list_workspace, then propose add_to_collection for each existing collection a paper fits and link_concept for each existing concept it fits, judged by its abstract. Propose create_concept only for a clear research topic papers share (link every saved paper it fits), and create_collection only when the user asks or several papers form a new group. Say which papers fit nowhere.
- When the question concerns papers listed in <scope>, start with those. When <reader> is present, the user is reading that paper right now.
- ${CANNOT_DO}
- Never invent keys. Do not repeat actions listed under <done_actions>. Finish as soon as you have what you need.`;
}

/**
 * What the assistant cannot do, and where the user does it instead: it says so rather than improvising or
 * proposing something close but different.
 */
const CANNOT_DO = `You cannot (say so plainly and tell the user where to do it, rather than doing something close but different): delete notes or highlights (a note's menu → Delete; click a highlight in the reader), upload a PDF file (the paper's page → Upload PDF), import BibTeX or a list of DOIs (Settings → Import), export (Settings → Export), share anything (the Share button on a collection, note or concept), change AI or account settings (Settings), edit a paper's title, authors or other metadata (scholarly data is read-only; "Refresh" on the paper's page fetches it again), or mark New papers as seen or check a followed search right away (the New papers page).`;

const WRITER_SYSTEM = `# Paperweave assistant writer
You write the reply of an AI assistant inside a scientific knowledge workspace, based on the conversation and the findings provided.

Rules:
- Ground factual claims about papers in the findings, citing sources inline by their keys in square brackets, e.g. [P3] or [P3, P7]; notes as [N1]. When the findings give the page, add it right after the key: [P3] (p. 5) — it becomes a link to that page. Only cite keys listed in <sources>. Never invent papers, numbers, pages or results.
- Distinguish what papers state from your own synthesis, and the user's own notes from the literature.
- When the user asked to add specific papers to the library, say which paper was found for each (title, first author, year, venue) so they can confirm it is the right one — or, if none or several matched, what was found and what to try or which they mean. For several papers, go through them as a short list: found, not found, or which one they mean.
- When the reply recommends papers found by searching the literature and <changes> is empty, end with one short line offering to add the ones the user picks (e.g. "the high-priority ones" from the ranking shown with the reply), and then to put them in collections and concepts.
- When the findings say "Placement not proposed yet", end the reply by asking whether to add the papers to collections and concepts, naming the likely ones from the hints in a few words (e.g. "It looks like it fits “Heart imaging” and the concept “MRI” — shall I add it?"). This question is the one exception to the rule below about not recommending collections or concepts.
- If <changes> lists workspace changes, tell the user briefly what you propose (they review and apply them in the card below your reply) or, if they were applied, what was done — and mention any that failed. Do not claim changes that are not listed, and do not recommend further collections, concepts or tags that are not listed: the card is where proposals live.
- If the findings are thin, say so plainly and suggest what to do next.
- If the user asked for something the assistant cannot do, say so and where in the app to do it. ${CANNOT_DO}
- Write well-structured Markdown, as long as the request needs and no longer. Do not include a reference list at the end (Paperweave shows the sources).`;

/** How the planner works in "field" mode: a whole field, in phases, with the budget spread across them. */
const FIELD_GUIDE = `Field analysis: the user wants a whole field mapped — its trends, landscape, current gaps and promising research directions. You have a large budget (several rounds); spread it over these phases rather than spending it all on searching:
  1. Scope (round 1): a broad search_papers (sort "citations") and one sort "newest", plus the user's own related papers (find_saved_papers with a query, list_workspace). Name the field's 4–8 sub-areas (methods, tasks, data or modalities, applications). If the field's name is ambiguous ("spatial AI"), take the reading closest to the user's library and broad usage, and keep it.
  2. Trends: one publication_trend call with the field and its sub-areas (similar breadth), and search_papers with "year_from" (last 2–3 years) sort "citations" for the recent breakthroughs that drive the growth; search_arxiv for what appeared in the last weeks.
  3. Landscape: per sub-area, the seminal papers (sort "citations", references of key papers) and the current state of the art (citations of key papers with "sort": "newest").
  4. Gaps: read the 5–10 most important recent papers with a focus on limitations and future work (find_passages with "limitation", "future work", "fails"), look for benchmarks that are saturated or criticized, and for combinations of sub-areas nobody has tried. Check each candidate gap with a targeted search before trusting it.
  5. Directions: for each strong gap, a concrete research topic; check it is open with a targeted search_papers and search_arxiv. Prefer topics that build on the user's library.
Finish when every phase has evidence; the report states what was not covered.`;

const DEEP_FORMAT = `Write a research report:
## Overview — a direct answer to the question in a few sentences.
Then sections organized by theme or approach (use descriptive headings), covering the key ideas and how they developed, with the most important papers (seminal and recent) and how they relate.
## Open problems — limitations, disagreements and gaps in the literature.
## Where to start reading — 3-6 papers in a sensible reading order, one line each on why.`;

const FIELD_FORMAT = `Write a field analysis:
## Overview — the field as scoped here (what is in, what is out, its sub-areas) and the answer in brief: where it is heading, the biggest gaps, the most promising directions.
## Trends — growth with the numbers from the publication counts (cite the years; say when the current year is incomplete and that counts depend on wording), which sub-areas are rising or fading, and the papers that set off each shift. Include a small Markdown table of the counts.
## Landscape — one subsection per sub-area: the key ideas, seminal and state-of-the-art papers, and how they relate.
## Current gaps — each gap: what is missing, the evidence (papers stating it, untried combinations, saturated or criticized benchmarks), and how sure you are.
## Research directions — 3–6 concrete research topics, each with: the question, why now, the closest existing papers, a first experiment, and the main risk. Mark those that build on the user's own library.
## Where to start reading — 4–8 papers in a sensible order, one line each on why.
Say what was not covered (sub-areas or sources not searched).`;

const CHAT_FORMAT = `Reply conversationally and directly, citing sources where you rely on them.`;

const NO_SEARCH_HINT = `Literature search is off for this message. If answering properly would need papers that are not in the user's workspace, say so and suggest turning on "Literature search".`;

export interface Turn {
  question: string;
  answer: string;
  /** How the reply's papers were ranked for the user (shown with it): read first, high, medium, low. */
  ranking?: string;
}

export interface ResearchState {
  question: string;
  mode: ResearchMode;
  history: Turn[];
  scopeKeys: string[];
  findings: string[];
  done: string[];
  /** Workspace changes proposed so far. */
  changes: ProposedChange[];
  /** What the model is given; set from the provider when the loop starts. */
  profile?: AssistantProfile;
  /** When asked from the PDF reader: the paper, the page on screen (with its text) and the selection. */
  reader?: {
    key: string;
    page: number | null;
    totalPages: number | null;
    pageText: string | null;
    selection: string | null;
  };
}

function sourcesBlock(sources: SourceRegistry, max = MAX_SOURCE_LINES) {
  const all = sources.all();
  const lines = all.slice(-max).map((s) => (s.type === "paper" ? paperLine(s) : `${s.key}: user's note "${s.title}"`));
  return `<sources>\n${lines.join("\n") || "(none yet)"}${all.length > max ? `\n(${all.length - max} earlier sources omitted)` : ""}\n</sources>`;
}

/** The most recent findings that fit the budget (older detail is dropped first). */
function findingsBlock(findings: string[], max = MAX_FINDINGS_CHARS) {
  const kept: string[] = [];
  let size = 0;
  for (let i = findings.length - 1; i >= 0; i--) {
    if (size + findings[i].length > max) {
      kept.unshift(`(${i + 1} earlier findings omitted for length; their sources are still listed in <sources>)`);
      break;
    }
    kept.unshift(findings[i]);
    size += findings[i].length;
  }
  return `<findings>\n${kept.join("\n\n") || "(nothing yet)"}\n</findings>`;
}

function changesBlock(changes: ProposedChange[]) {
  if (!changes.length) return "";
  const line = (c: ProposedChange) =>
    `- [${c.status === "failed" ? `failed: ${c.error ?? "error"}` : c.status}] ${c.label}${c.priority ? ` (${c.priority} priority${c.why ? `: ${c.why}` : ""})` : ""}`;
  return `<changes>\n${changes.map(line).join("\n")}\n</changes>`;
}

function contextBlocks(state: ResearchState, sources: SourceRegistry) {
  const low = !!state.profile?.low;
  const answerChars = low ? LOW_BUDGET.answerChars : 3000;
  const history = state.history
    .slice(low ? -LOW_BUDGET.turns : -4)
    .map(
      (t) =>
        `<user>${t.question}</user>\n<assistant>${t.answer.length > answerChars ? `${t.answer.slice(0, answerChars)}…` : t.answer}</assistant>${
          t.ranking ? `\n<ranking>Shown with this reply — ${t.ranking}</ranking>` : ""
        }`,
    );
  const scope = state.scopeKeys.length
    ? `<scope>The user pointed this conversation at: ${state.scopeKeys.join(", ")}</scope>`
    : "";
  const r = state.reader;
  const reader = r
    ? `<reader>The user is reading ${r.key} in the PDF reader${r.page ? `, on page ${r.page}${r.totalPages ? ` of ${r.totalPages}` : ""}` : ""}. "This section / figure / page / passage" refers to what they are looking at.${
        r.pageText ? `\n<current_page number="${r.page}">\n${r.pageText}\n</current_page>` : ""
      }${r.selection ? `\n<selection>\n${r.selection}\n</selection>` : ""}\n</reader>`
    : "";
  return [
    history.length ? `<conversation_so_far>\n${history.join("\n")}\n</conversation_so_far>` : "",
    `<question>${state.question}</question>`,
    scope,
    reader,
    sourcesBlock(sources, low ? LOW_BUDGET.sourceLines : MAX_SOURCE_LINES),
    findingsBlock(state.findings, low ? LOW_BUDGET.findingsChars : MAX_FINDINGS_CHARS),
    changesBlock(state.changes),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function roundPrompt(state: ResearchState, sources: SourceRegistry, round: number) {
  const limits = limitsFor(state);
  return `${contextBlocks(state, sources)}

<done_actions>
${state.done.filter((d) => !d.startsWith("change:")).join("\n") || "(none)"}
</done_actions>

This is round ${round} of at most ${limits.rounds}. Use at most ${limits.actionsPerRound} actions this round.
Reply with JSON only.`;
}

export function writerPrompt(state: ResearchState, sources: SourceRegistry) {
  return `${contextBlocks(state, sources)}

${state.mode === "deep" ? DEEP_FORMAT : state.mode === "field" ? FIELD_FORMAT : CHAT_FORMAT}${state.mode === "chat" ? `\n${NO_SEARCH_HINT}` : ""}
Reply to the message in <question>${state.history.length ? " (it continues the conversation above)" : ""}.`;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface ResearchSink {
  /** Adds a visible step and returns its id. */
  step(kind: ResearchStepKind, label: string, detail?: string): string;
  finish(id: string, patch: { status: "done" | "error"; count?: number; detail?: string }): void;
  /** The reply so far (streamed). */
  text(full: string): void;
  /** The current proposed changes. */
  changes(items: ProposedChange[]): void;
}

export async function runResearchLoop(opts: {
  provider: AIProvider;
  ctx: ToolContext;
  state: ResearchState;
  sink: ResearchSink;
  signal: AbortSignal;
  /** Runs before the reply is written, e.g. to auto-apply the proposed changes. */
  beforeWrite?: (changes: ProposedChange[]) => Promise<ProposedChange[]>;
}): Promise<string> {
  const { provider, state, sink, signal } = opts;
  const ctx: ToolContext = { ...opts.ctx, provider, signal };
  state.profile ??= { low: lowContext(provider), images: readsImages(provider) };
  const profile = state.profile;
  const limits = limitsFor(state);
  const system = agentSystem(state.mode, profile);
  let actionsRun = 0;

  for (let round = 1; round <= limits.rounds && actionsRun < limits.totalActions; round++) {
    signal.throwIfAborted();
    const planId = sink.step("plan", round === 1 ? "Planning" : "Deciding what to do next");
    const prompt = roundPrompt(state, ctx.sources, round);
    let decision = parseDecision(
      await complete(provider, { system, messages: [{ role: "user", content: prompt }], signal }),
    );
    if (!decision) {
      // One retry with a reminder of the format; then fall back to writing with what we have.
      decision = parseDecision(
        await complete(provider, {
          system,
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: "(invalid reply)" },
            { role: "user", content: "Your reply was not valid JSON. Reply with the JSON object only." },
          ],
          signal,
        }),
      );
    }
    if (!decision) {
      sink.finish(planId, {
        status: "error",
        detail: "The model did not return a usable plan; replying with what was found.",
      });
      break;
    }
    const blocked = decision.actions.filter((a) => state.mode === "chat" && LITERATURE_TOOLS.has(a.tool));
    const unoffered = decision.actions.filter((a) => !blocked.includes(a) && !offersTool(profile, a.tool));
    if (unoffered.length) {
      state.findings.push(
        `${unoffered.map((a) => a.tool).join(", ")}: not available with this model's settings (Settings → AI).`,
      );
    }
    const fresh = decision.actions
      .filter((a) => !blocked.includes(a) && !unoffered.includes(a) && !state.done.includes(actionId(a)))
      .slice(0, Math.min(limits.actionsPerRound, limits.totalActions - actionsRun));
    sink.finish(planId, { status: "done", detail: decision.thought || undefined });
    if (blocked.length) {
      state.findings.push(
        `${blocked.map((a) => a.tool).join(", ")}: not available because literature search is off for this message.`,
      );
    }
    if (decision.done || !fresh.length) break;
    for (const a of fresh) state.done.push(actionId(a));

    // Reading actions run in parallel; failures are reported to the model, not fatal.
    const reads = fresh.filter((a): a is ReadAction => !isChange(a));
    const results = await Promise.all(
      reads.map(async (action) => {
        const spec = toolFor(action, ctx.sources);
        const id = sink.step(spec.kind, spec.label);
        try {
          const result = await spec.run(ctx);
          sink.finish(id, { status: "done", count: result.count });
          return result.report;
        } catch (err) {
          if (signal.aborted) throw err;
          const known = err instanceof ToolInputError || err instanceof ScholarlyUnavailableError;
          const reason = known ? err.message : "the data source is unavailable right now";
          if (!known) console.error("[assistant] action failed", action, err);
          sink.finish(id, { status: "error", detail: reason });
          return `${spec.label}: failed (${reason}).`;
        }
      }),
    );
    state.findings.push(...results);

    // Proposed changes are validated one by one (later ones may build on earlier ones).
    for (const action of fresh.filter(isChange)) {
      const id = sink.step("change", "Preparing a change to your workspace");
      try {
        const { change, message } = await proposeChange(ctx.workspaceId, action, ctx.sources, state.changes);
        if (change) {
          const i = state.changes.findIndex((c) => c.id === change.id);
          if (i >= 0) state.changes[i] = change;
          else state.changes.push(change);
          sink.changes(state.changes);
        }
        sink.finish(id, { status: change ? "done" : "error", detail: change ? change.label : message });
        state.findings.push(message);
      } catch (err) {
        if (signal.aborted) throw err;
        console.error("[assistant] could not propose change", action, err);
        sink.finish(id, { status: "error", detail: "This change could not be prepared." });
        state.findings.push(`${action.tool}: could not be prepared.`);
      }
    }
    actionsRun += fresh.length;
  }

  signal.throwIfAborted();
  if (opts.beforeWrite && state.changes.length) {
    state.changes = await opts.beforeWrite(state.changes);
    sink.changes(state.changes);
  }
  const writeId = sink.step(
    "write",
    state.mode === "deep"
      ? "Writing the report"
      : state.mode === "field"
        ? "Writing the field analysis"
        : "Writing the reply",
  );
  let text = "";
  try {
    for await (const chunk of provider.stream({
      system: WRITER_SYSTEM,
      messages: [{ role: "user", content: writerPrompt(state, ctx.sources) }],
      signal,
    })) {
      text += chunk;
      sink.text(text);
    }
  } catch (err) {
    sink.finish(writeId, { status: "error" });
    throw err;
  }
  if (!text.trim()) {
    sink.finish(writeId, { status: "error" });
    throw new AIError("unavailable", "The AI provider returned an empty answer.");
  }
  sink.finish(writeId, { status: "done" });
  return text;
}

/** Citation keys used in an answer, in order of first appearance. */
export function citedKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[((?:[PN]\d+)(?:\s*[,;]\s*[PN]\d+)*)\]/g)) {
    for (const k of m[1].split(/\s*[,;]\s*/)) if (!out.includes(k)) out.push(k);
  }
  return out;
}
