/**
 * Notes as numbered top-level blocks, so the assistant can edit exactly the blocks it means. Blocks it
 * does not touch stay as they are — including callouts, to-dos, tables and links, which a Markdown
 * round trip of the whole note would flatten.
 */
import { markdownToDoc, type CitationTarget } from "@/lib/markdown-doc";
import { docToMarkdown, parseMentionId, walk, type PMNode } from "@/lib/prosemirror";
import type { NoteBlockEdit } from "@/lib/types";

/** Each top-level block of a note as Markdown, in order. */
export function noteBlocks(doc: PMNode): string[] {
  return (doc.content ?? []).map((block) => docToMarkdown({ type: "doc", content: [block] }).trim());
}

/** The note as the assistant reads it: "[B1] …" per block. */
export function numberedNote(doc: PMNode, maxChars: number): string {
  const lines: string[] = [];
  let size = 0;
  const blocks = noteBlocks(doc);
  for (const [i, text] of blocks.entries()) {
    const line = `[B${i + 1}] ${text || "(empty)"}`;
    if (size + line.length > maxChars) {
      lines.push(`… (${blocks.length - i} more blocks not shown)`);
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join("\n");
}

/** The links (mentions) in a note by label, so `[[label]]` in edited text keeps pointing where it did. */
export function mentionsByLabel(doc: PMNode): Map<string, CitationTarget> {
  const out = new Map<string, CitationTarget>();
  walk(doc, (n) => {
    if (n.type !== "mention") return;
    const ref = parseMentionId(n.attrs?.id);
    const label = String(n.attrs?.label ?? "");
    if (ref && label) out.set(label, { type: ref.type, id: ref.id, label });
  });
  return out;
}

export interface PlannedEdit {
  op: NoteBlockEdit["op"];
  block: number;
  /** The new blocks (replace / insert). */
  nodes?: PMNode[];
}

export interface EditInput {
  op: NoteBlockEdit["op"];
  block: number;
  content?: string;
}

/**
 * Checks block edits against a note and converts their Markdown. Returns the review text (before /
 * after) and the planned edits, or an error message for the model.
 */
export function planBlockEdits(
  doc: PMNode,
  edits: EditInput[],
  cite: (key: string) => CitationTarget | undefined,
): { edits: NoteBlockEdit[]; planned: PlannedEdit[] } | { error: string } {
  const blocks = noteBlocks(doc);
  const links = mentionsByLabel(doc);
  const resolve = (k: string) => (k.startsWith("[[") ? links.get(k.slice(2, -2)) : cite(k));
  const touched = new Set<number>();
  const review: NoteBlockEdit[] = [];
  const planned: PlannedEdit[] = [];
  for (const e of edits) {
    const min = e.op === "insert" ? 0 : 1;
    if (e.block < min || e.block > blocks.length) {
      return { error: `block ${e.block} does not exist (the note has ${blocks.length} blocks).` };
    }
    if (e.op !== "insert") {
      if (touched.has(e.block)) return { error: `block ${e.block} is edited twice.` };
      touched.add(e.block);
    }
    if (e.op !== "delete" && !e.content?.trim()) return { error: `${e.op} of block ${e.block} has no content.` };
    const nodes = e.op === "delete" ? undefined : (markdownToDoc(e.content!, resolve).content ?? []);
    if (nodes && !nodes.length) return { error: `${e.op} of block ${e.block} has no content.` };
    planned.push({ op: e.op, block: e.block, nodes });
    review.push({
      op: e.op,
      block: e.block,
      ...(e.op !== "insert" ? { before: blocks[e.block - 1] } : {}),
      ...(nodes ? { after: noteBlocks({ type: "doc", content: nodes }).join("\n\n") } : {}),
    });
  }
  return { edits: review, planned };
}

/** The note's content with the edits applied (block numbers refer to the content they were planned on). */
export function applyBlockEdits(doc: PMNode, planned: PlannedEdit[]): PMNode {
  const blocks = doc.content ?? [];
  const insertsAfter = (i: number) =>
    planned.filter((e) => e.op === "insert" && e.block === i).flatMap((e) => e.nodes ?? []);
  const out: PMNode[] = [...insertsAfter(0)];
  blocks.forEach((block, idx) => {
    const n = idx + 1;
    const edit = planned.find((e) => e.op !== "insert" && e.block === n);
    if (!edit) out.push(block);
    else if (edit.op === "replace") out.push(...(edit.nodes ?? []));
    out.push(...insertsAfter(n));
  });
  return { ...doc, content: out.length ? out : [{ type: "paragraph" }] };
}
