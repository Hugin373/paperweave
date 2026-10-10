/**
 * AI features. Each task builds a prompt from the specific paper/note/selection involved —
 * never from unrelated workspace data — and calls the configured provider through the
 * AIProvider interface.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { aiResults, libraryItems, paperFilePages, papers } from "@/server/db/schema";
import { getCitationEdge } from "@/server/papers/citations";
import { getVisiblePaper } from "@/server/papers/service";
import type { AiBasis } from "@/lib/types";
import { ABSTRACT_BASIS, loadPaperText, readyFile, relevantParts, wholePaper, type PaperText } from "./paper-text";
import { complete, type AIProvider, type ChatMessage, type CompletionRequest } from "./types";

type PaperRow = typeof papers.$inferSelect;

const MAX_CONTEXT_CHARS = 48_000;

const BASE_RULES = `You are a research assistant inside a scientific knowledge workspace.
Ground every statement in the provided material. If the material does not contain the answer, say so plainly instead of guessing, and distinguish clearly between what the paper states and general background knowledge.
Write concise, well-structured Markdown. Do not invent citations, numbers, or results.`;

export function paperHeader(p: PaperRow) {
  const authors = p.authors
    .slice(0, 12)
    .map((a) => a.name)
    .join(", ");
  return [
    `Title: ${p.title}`,
    authors && `Authors: ${authors}${p.authors.length > 12 ? ", et al." : ""}`,
    p.year && `Year: ${p.year}`,
    p.venue && `Venue: ${p.venue}`,
    `Abstract: ${p.abstract ?? "(no abstract available)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const SOURCE_NAME: Record<PaperText["source"], string> = {
  pdf: "the paper's PDF",
  open_access: "the paper's open-access PDF",
  pmc: "the paper's full text from PubMed Central",
};

/**
 * The paper as the model sees it: metadata, then its full text (whole-paper tasks) or the parts
 * that match a question, within `budget` characters, and what was included.
 */
export async function paperContext(
  workspaceId: string,
  paper: PaperRow,
  opts: { question?: string; budget: number },
): Promise<{ context: string; basis: AiBasis }> {
  const full = await loadPaperText(workspaceId, paper.id);
  if (!full) {
    return {
      context: `${paperHeader(paper)}\n\nOnly the metadata and abstract are available (no full text). Say so if that limits the answer.`,
      basis: ABSTRACT_BASIS,
    };
  }
  const { body, basis } = opts.question
    ? relevantParts(full, opts.question, opts.budget)
    : wholePaper(full, opts.budget);
  const unit = full.unit === "section" ? "sections" : "pages";
  const note =
    basis.selection === "relevant"
      ? `Excerpts from ${SOURCE_NAME[full.source]} (the ${unit} that best match the question) follow.`
      : `The full text of ${SOURCE_NAME[full.source]} follows${basis.skippedReferences ? ", without the reference list" : ""}.${
          basis.condensed ? ` Long ${unit} were shortened to fit, so some details may be missing.` : ""
        }`;
  return { context: `${paperHeader(paper)}\n\n${note}\n\n${body}`, basis };
}

// ---------------------------------------------------------------------------
// Paper-level analyses (persisted as clearly-labeled AI results)
// ---------------------------------------------------------------------------

export const PAPER_ANALYSES = {
  summary: {
    title: "Summary",
    instruction:
      "Summarize this paper for a researcher deciding whether to read it in depth: the problem, the approach, the main findings, and limitations. Use short sections.",
  },
  contributions: {
    title: "Key contributions",
    instruction:
      "List the paper's key contributions as a numbered list. For each, state what is new compared with prior work and the evidence the paper gives for it.",
  },
  prerequisites: {
    title: "Prerequisites",
    instruction:
      "Explain the background concepts a reader needs to understand this paper. For each concept give a short, intuitive explanation and why it matters for this paper. Order them from most fundamental to most specific.",
  },
} as const;
export type PaperAnalysisKind = keyof typeof PAPER_ANALYSES;

export async function paperAnalysisRequest(
  workspaceId: string,
  paperId: string,
  kind: PaperAnalysisKind,
  budget: number,
) {
  const paper = await getVisiblePaper(workspaceId, paperId);
  const { context, basis } = await paperContext(workspaceId, paper, { budget });
  const cite = basis.source === "abstract" ? "" : `\nPoint to where things are stated, like ${CITE_HINT[basis.unit]}.`;
  return {
    paper,
    basis,
    request: {
      system: BASE_RULES,
      messages: [
        { role: "user", content: `${PAPER_ANALYSES[kind].instruction}${cite}\n\n<paper>\n${context}\n</paper>` },
      ],
    } satisfies CompletionRequest,
  };
}

const CITE_HINT: Record<AiBasis["unit"], string> = { page: "(p. 4)", section: "(sec. 3)" };

export async function saveAiResult(input: {
  workspaceId: string;
  userId: string;
  paperId: string | null;
  kind: string;
  content: string;
  provider: AIProvider;
  basis?: AiBasis | null;
}) {
  await db.insert(aiResults).values({
    workspaceId: input.workspaceId,
    paperId: input.paperId,
    kind: input.kind,
    content: input.content,
    provider: input.provider.kind,
    model: input.provider.model,
    basis: input.basis ?? null,
    createdBy: input.userId,
  });
}

export async function latestPaperResults(workspaceId: string, paperId: string) {
  const rows = await db
    .selectDistinctOn([aiResults.kind])
    .from(aiResults)
    .where(and(eq(aiResults.workspaceId, workspaceId), eq(aiResults.paperId, paperId)))
    .orderBy(aiResults.kind, desc(aiResults.createdAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    content: r.content,
    provider: r.provider,
    model: r.model,
    basis: r.basis,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Questions, explanations
// ---------------------------------------------------------------------------

export async function paperQuestionRequest(
  workspaceId: string,
  paperId: string,
  question: string,
  history: ChatMessage[],
  budget: number,
): Promise<{ request: CompletionRequest; basis: AiBasis }> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  const { context, basis } = await paperContext(workspaceId, paper, { question, budget });
  const cite =
    basis.source === "abstract"
      ? ""
      : ` Cite where you found things, like ${CITE_HINT[basis.unit]}, when you rely on the excerpts.`;
  return {
    basis,
    request: {
      system: `${BASE_RULES}\nAnswer questions about the paper below.${cite}\n\n<paper>\n${context}\n</paper>`,
      messages: [...history.slice(-8), { role: "user", content: question }],
    },
  };
}

export async function explainSelectionRequest(
  workspaceId: string,
  paperId: string,
  input: { text: string; pageNumber?: number; question?: string },
): Promise<CompletionRequest> {
  const paper = await getVisiblePaper(workspaceId, paperId);
  let pageText = "";
  if (input.pageNumber) {
    const file = await readyFile(workspaceId, paperId);
    if (file) {
      const [page] = await db
        .select({ text: paperFilePages.text })
        .from(paperFilePages)
        .where(and(eq(paperFilePages.fileId, file.id), eq(paperFilePages.pageNumber, input.pageNumber)));
      pageText = page?.text.slice(0, 12000) ?? "";
    }
  }
  const ask =
    input.question?.trim() ||
    "Explain this passage clearly for a researcher who is not a specialist in this exact subfield: what it says, the terms it uses, and why it matters in the paper.";
  return {
    system: BASE_RULES,
    messages: [
      {
        role: "user",
        content: `${ask}\n\n<selected_passage>\n${input.text}\n</selected_passage>\n\n<paper_metadata>\n${paperHeader(paper)}\n</paper_metadata>${
          pageText ? `\n\n<surrounding_page page="${input.pageNumber}">\n${pageText}\n</surrounding_page>` : ""
        }`,
      },
    ],
  };
}

export async function citationExplainRequest(
  workspaceId: string,
  citingId: string,
  citedId: string,
): Promise<CompletionRequest> {
  const [citing, cited] = await Promise.all([
    getVisiblePaper(workspaceId, citingId),
    getVisiblePaper(workspaceId, citedId),
  ]);
  const edge = await getCitationEdge(citingId, citedId);
  const contexts = edge?.contexts.length
    ? `Citation contexts (sentences in the citing paper that cite the other paper):\n${edge.contexts.map((c) => `- ${c}`).join("\n")}`
    : "No citation-context sentences are available; rely on the abstracts.";
  const intents = edge?.intents.length ? `Citation intent labels from the data source: ${edge.intents.join(", ")}` : "";
  return {
    system: BASE_RULES,
    messages: [
      {
        role: "user",
        content: `Explain how the citing paper relates to the cited paper: why it likely cites it, what it builds on or argues against, and how their approaches differ. The citation itself is a verified fact from scholarly data; your explanation is an interpretation and should say how confident it can be.\n\n<citing_paper>\n${paperHeader(citing)}\n</citing_paper>\n\n<cited_paper>\n${paperHeader(cited)}\n</cited_paper>\n\n${contexts}\n${intents}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Search assistance
// ---------------------------------------------------------------------------

function parseJsonObject<T>(text: string): T | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

/** Rewrites a natural-language research question into a scholarly search query. */
export async function rewriteSearchQuery(provider: AIProvider, question: string) {
  const text = await complete(provider, {
    system: `You turn research questions into effective queries for academic search engines (Semantic Scholar, OpenAlex). Return JSON only: {"query": string, "explanation": string}. The query should be 3-10 keywords or a short phrase using standard terminology from the field; no boolean operators.`,
    messages: [{ role: "user", content: `Question: ${question}` }],
    maxTokens: 4000,
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = parseJsonObject<{ query?: string; explanation?: string }>(text);
  const query = parsed?.query?.trim();
  if (!query) return null;
  return { query: query.slice(0, 300), explanation: parsed?.explanation?.slice(0, 500) ?? "" };
}

export async function searchSummaryRequest(
  workspaceId: string,
  question: string,
  paperIds: string[],
): Promise<CompletionRequest> {
  const rows = await Promise.all(paperIds.slice(0, 12).map((id) => getVisiblePaper(workspaceId, id)));
  const list = rows
    .map((p, i) => `[${i + 1}] ${p.title} (${p.year ?? "n.d."})\n${(p.abstract ?? "No abstract.").slice(0, 1500)}`)
    .join("\n\n");
  return {
    system: BASE_RULES,
    messages: [
      {
        role: "user",
        content: `A researcher searched for: "${question}". Based only on these search results, give a short overview of what they cover, group them by approach or theme, and point out which look most relevant to the query and why. Refer to results by their [number].\n\n${list}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Notes and concepts
// ---------------------------------------------------------------------------

export const NOTE_ACTIONS = {
  summarize: "Summarize this note in a few bullet points.",
  rewrite:
    "Rewrite the text for clarity and flow while preserving every idea, claim and reference. Return only the rewritten text.",
  explain: "Explain the ideas in this text more simply, as if to a smart colleague from a neighboring field.",
  organize:
    "Reorganize this note into a clear structure with headings and bullet points. Keep all content; do not add new claims.",
  suggest_links:
    "Suggest which of the listed concepts and papers this note should link to, and briefly why. Only suggest items from the lists. Format as a bullet list of exact names.",
  ask: "",
} as const;
export type NoteAction = keyof typeof NOTE_ACTIONS;

export async function noteAssistRequest(
  workspaceId: string,
  input: { action: NoteAction; text: string; question?: string },
): Promise<CompletionRequest> {
  let extra = "";
  if (input.action === "suggest_links") {
    const { listConcepts } = await import("@/server/knowledge/concepts");
    const [conceptList, paperList] = await Promise.all([
      listConcepts(workspaceId),
      db
        .select({ title: papers.title })
        .from(libraryItems)
        .innerJoin(papers, eq(papers.id, libraryItems.paperId))
        .where(eq(libraryItems.workspaceId, workspaceId))
        .orderBy(desc(libraryItems.updatedAt))
        .limit(150),
    ]);
    extra = `\n\n<concepts>\n${conceptList.map((c) => `- ${c.name}`).join("\n") || "(none)"}\n</concepts>\n<papers>\n${
      paperList.map((p) => `- ${p.title}`).join("\n") || "(none)"
    }\n</papers>`;
  }
  const instruction =
    input.action === "ask" ? input.question?.trim() || "Help me with this note." : NOTE_ACTIONS[input.action];
  return {
    system: `${BASE_RULES}\nThe user's note is their own authoritative writing; you are assisting, not replacing it.`,
    messages: [
      { role: "user", content: `${instruction}\n\n<note>\n${input.text.slice(0, MAX_CONTEXT_CHARS)}\n</note>${extra}` },
    ],
  };
}

export async function suggestConcepts(provider: AIProvider, workspaceId: string, paperId: string, existing: string[]) {
  const paper = await getVisiblePaper(workspaceId, paperId);
  const text = await complete(provider, {
    system: `${BASE_RULES}\nYou identify key scientific concepts. Return JSON only: {"concepts": [{"name": string, "description": string}]}. Suggest 3-8 concepts central to understanding the paper: methods, phenomena, data types, tasks, datasets or theoretical ideas. Concepts connect papers across the user's library, so favour broad, reusable research topics of 1–3 words that many other papers share: data or modality ("MRI", "point cloud"), method family ("diffusion models", "transformers"), task ("segmentation", "registration"). Add at most two specific ideas particular to this paper. Avoid words that are not research topics ("method", "performance"). Descriptions are one sentence. Prefer reusing an existing concept name when it fits.`,
    messages: [
      {
        role: "user",
        content: `Existing concepts in the user's workspace: ${existing.slice(0, 200).join("; ") || "(none)"}\n\n<paper>\n${paperHeader(paper)}\n</paper>`,
      },
    ],
    maxTokens: 8000,
    signal: AbortSignal.timeout(90_000),
  });
  const parsed = parseJsonObject<{ concepts?: { name?: string; description?: string }[] }>(text);
  return (parsed?.concepts ?? [])
    .filter((c): c is { name: string; description?: string } => typeof c.name === "string" && !!c.name.trim())
    .slice(0, 10)
    .map((c) => ({ name: c.name.trim().slice(0, 120), description: (c.description ?? "").trim().slice(0, 500) }));
}
