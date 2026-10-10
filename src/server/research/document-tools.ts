/**
 * Tools that look at a paper as a document rather than as text: a page seen as an image (figures,
 * tables, equations, diagrams), and what changed between two arXiv versions. Read-only.
 */
import { loadPaperText } from "@/server/ai/paper-text";
import { AIError, complete } from "@/server/ai/types";
import { identifiersFor, getVisiblePaper } from "@/server/papers/service";
import { paperPdfBytes, pdfTextAt } from "@/server/files/service";
import { scholarly } from "@/server/scholarly/service";
import { diffSentences, sentences, type DiffHunk } from "@/lib/sentence-diff";
import { paperSource, ToolInputError, type ToolContext, type ToolResult } from "./tools";

// ---------------------------------------------------------------------------
// Looking at a page
// ---------------------------------------------------------------------------

/** Renders one page of a PDF as a PNG about 1400 pixels wide. */
export async function renderPdfPage(bytes: Uint8Array, page: number): Promise<{ png: Buffer; pages: number }> {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes.slice());
  if (page < 1 || page > pdf.numPages)
    throw new ToolInputError(`The PDF has ${pdf.numPages} pages; there is no page ${page}.`);
  const { width } = (await pdf.getPage(page)).getViewport({ scale: 1 });
  const image = await renderPageAsImage(pdf, page, {
    canvasImport: () => import("@napi-rs/canvas"),
    scale: Math.min(2.5, Math.max(1, 1400 / width)),
  });
  return { png: Buffer.from(image), pages: pdf.numPages };
}

const VIEW_SYSTEM = `You look at one page of a scientific paper (an image, with its extracted text for reference) and describe what it shows for a reader's question. Read figures, tables, plots, diagrams and equations precisely: axes and units, legends, line and marker styles, arrows, symbols, values in tables, the structure of equations. Quote numbers exactly as shown. Say plainly what you cannot read or are unsure about. Do not describe things that are not on the page.`;

/** One page of a paper seen as an image by the assistant's AI, answering a question about it. */
export async function viewPage(
  ctx: ToolContext,
  input: { paper: string; page: number; question?: string },
): Promise<ToolResult> {
  if (!ctx.provider) throw new ToolInputError("view_page needs the assistant's AI.");
  const source = paperSource(ctx, input.paper);
  const paper = await getVisiblePaper(ctx.workspaceId, source.id);
  const bytes = await paperPdfBytes(ctx.workspaceId, source.id);
  if (!bytes) {
    return {
      report: `${input.paper} p. ${input.page}: no PDF is available to look at (read_paper gives the text, if any).`,
    };
  }
  const { png, pages } = await renderPdfPage(bytes, input.page);
  const text = await loadPaperText(ctx.workspaceId, source.id).catch(() => null);
  const pageText = text?.unit === "page" ? text.parts.find((p) => p.n === input.page)?.text : undefined;
  const question = input.question?.trim() || "What does this page show? Explain its figures, tables and equations.";
  try {
    const answer = await complete(ctx.provider, {
      system: VIEW_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Page ${input.page} of ${pages} of "${paper.title}".${
            pageText ? `\n<page_text>\n${pageText.slice(0, 6000)}\n</page_text>` : ""
          }\n\nQuestion: ${question}`,
        },
      ],
      images: [{ mediaType: "image/png", data: png.toString("base64") }],
      signal: ctx.signal,
    });
    return {
      report: `What is on ${input.paper} p. ${input.page} (looked at as an image; question: ${question}):\n${answer.trim()}`,
    };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const reason = err instanceof AIError ? err.message : "the AI could not look at the image";
    return {
      report: `${input.paper} p. ${input.page}: the page could not be looked at as an image (${reason}). Use read_paper with "pages": "${input.page}" for its text.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const MAX_HUNKS = 40;

function hunkLine(h: DiffHunk) {
  const quote = (list: DiffHunk["removed"]) => {
    const t = list.map((s) => s.text).join(" ");
    return t.length > 400 ? `${t.slice(0, 400)}…` : t;
  };
  const page = (h.added[0] ?? h.removed[0]).page;
  const where = h.added.length ? `p. ${page} of the newer version` : `p. ${page} of the older version`;
  if (h.removed.length && h.added.length) return `- ${where}, changed: “${quote(h.removed)}” → “${quote(h.added)}”`;
  if (h.added.length) return `- ${where}, added: “${quote(h.added)}”`;
  return `- ${where}, removed: “${quote(h.removed)}”`;
}

/** What changed between two arXiv versions of a paper, sentence by sentence, with pages. */
export async function compareVersions(
  ctx: ToolContext,
  input: { paper: string; from?: number; to?: number },
): Promise<ToolResult> {
  const source = paperSource(ctx, input.paper);
  const arxiv = (await identifiersFor([source.id])).get(source.id)?.arxiv;
  if (!arxiv) {
    return { report: `${input.paper} is not on arXiv; only arXiv keeps every earlier version of a paper to compare.` };
  }
  const latest = await scholarly().arxivLatestVersion(arxiv);
  if (!latest) throw new ToolInputError(`arXiv did not say which versions of ${input.paper} exist; try again later.`);
  if (latest < 2) return { report: `${input.paper} (arXiv ${arxiv}) has only one version.` };
  const to = Math.min(input.to ?? latest, latest);
  const from = input.from ?? to - 1;
  if (from < 1 || from >= to)
    throw new ToolInputError(`Versions run from v1 to v${latest}; compare an earlier one with a later one.`);
  const [older, newer] = await Promise.all([
    pdfTextAt(`https://arxiv.org/pdf/${arxiv}v${from}`),
    pdfTextAt(`https://arxiv.org/pdf/${arxiv}v${to}`),
  ]);
  const hunks = diffSentences(sentences(older), sentences(newer));
  const removed = hunks.reduce((n, h) => n + h.removed.length, 0);
  const added = hunks.reduce((n, h) => n + h.added.length, 0);
  const head = `${input.paper}, arXiv ${arxiv}: v${from} (${older.length} pages) → v${to} (${newer.length} pages, newest is v${latest}). ${
    hunks.length
      ? `${hunks.length} changed places: ${removed} sentences removed or rewritten, ${added} added or rewritten.`
      : "No changes in the text."
  }`;
  const listed = hunks.slice(0, MAX_HUNKS).map(hunkLine);
  return {
    report: `${head}${listed.length ? `\n${listed.join("\n")}` : ""}${
      hunks.length > MAX_HUNKS ? `\n(${hunks.length - MAX_HUNKS} more changes not listed.)` : ""
    }`,
    count: hunks.length,
  };
}
