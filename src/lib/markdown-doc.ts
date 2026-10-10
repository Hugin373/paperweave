/**
 * Converts the Markdown that AI answers use into a note document. Citation keys such as [P3] or
 * [P3, N1] become mention nodes, so a saved research report links to the papers and notes it cites
 * (and shows up in their backlinks and the knowledge graph).
 */
import type { PMNode } from "./prosemirror";

export interface CitationTarget {
  type: "paper" | "note" | "concept";
  id: string;
  label: string;
}

type Mark = NonNullable<PMNode["marks"]>[number];

/**
 * Inline Markdown → text/mention nodes (bold, italic, code, links, citations). `[[label]]` (how notes
 * show their existing links as Markdown) becomes a mention again when `cite` knows the label.
 */
export function inlineNodes(
  text: string,
  cite: (key: string) => CitationTarget | undefined,
  marks: Mark[] = [],
): PMNode[] {
  const out: PMNode[] = [];
  const pushText = (t: string, m: Mark[]) => {
    if (!t) return;
    const last = out.at(-1);
    if (last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(m)) last.text += t;
    else out.push(m.length ? { type: "text", text: t, marks: m } : { type: "text", text: t });
  };
  // Tokens: code, bold, italic, link, citation group, existing link ([[label]]).
  const token =
    /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(\[(?:[PN]\d+)(?:\s*[,;]\s*[PN]\d+)*\])|(\[\[[^\]]+\]\])/g;
  let last = 0;
  for (const m of text.matchAll(token)) {
    pushText(text.slice(last, m.index), marks);
    last = m.index! + m[0].length;
    if (m[1]) pushText(m[1].slice(1, -1), [...marks, { type: "code" }]);
    else if (m[2]) out.push(...inlineNodes(m[2].slice(2, -2), cite, [...marks, { type: "bold" }]));
    else if (m[3]) out.push(...inlineNodes(m[3].slice(1, -1), cite, [...marks, { type: "italic" }]));
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]("));
      pushText(label, [...marks, { type: "link", attrs: { href: m[5] } }]);
    } else if (m[6]) {
      const keys = m[6].slice(1, -1).split(/\s*[,;]\s*/);
      const targets = keys.map((k) => cite(k));
      if (targets.every(Boolean)) {
        targets.forEach((t, i) => {
          if (i > 0) pushText(", ", marks);
          out.push({ type: "mention", attrs: { id: `${t!.type}:${t!.id}`, label: t!.label } });
        });
      } else {
        pushText(m[6], marks);
      }
    } else if (m[7]) {
      const t = cite(m[7]);
      if (t) out.push({ type: "mention", attrs: { id: `${t.type}:${t.id}`, label: t.label } });
      else pushText(m[7].slice(2, -2), marks);
    }
  }
  pushText(text.slice(last), marks);
  return out;
}

const paragraph = (text: string, cite: (key: string) => CitationTarget | undefined): PMNode => {
  const content = inlineNodes(text.trim(), cite);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

/** Block-level Markdown → note document (headings, lists, quotes, code, rules, paragraphs). */
export function markdownToDoc(markdown: string, cite: (key: string) => CitationTarget | undefined): PMNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: PMNode[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|>\s?|```|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l.trim());

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim() || null;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push({
        type: "codeBlock",
        attrs: { language: lang },
        content: code.length ? [{ type: "text", text: code.join("\n") }] : undefined,
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        type: "heading",
        attrs: { level: Math.min(3, heading[1].length) },
        content: inlineNodes(heading[2].replace(/#+\s*$/, "").trim(), cite),
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "horizontalRule" });
      i++;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) quoted.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ type: "blockquote", content: markdownToDoc(quoted.join("\n"), cite).content ?? [] });
      continue;
    }
    const bullet = /^[-*+]\s+/;
    const ordered = /^\d+[.)]\s+/;
    if (bullet.test(trimmed) || ordered.test(trimmed)) {
      const kind = bullet.test(trimmed) ? bullet : ordered;
      const items: PMNode[] = [];
      while (i < lines.length && kind.test(lines[i].trim())) {
        let text = lines[i++].trim().replace(kind, "");
        // Continuation lines (indented, not a new block) belong to the item.
        while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && !isBlockStart(lines[i])) {
          text += ` ${lines[i++].trim()}`;
        }
        items.push({ type: "listItem", content: [paragraph(text, cite)] });
      }
      blocks.push({ type: kind === bullet ? "bulletList" : "orderedList", content: items });
      continue;
    }
    // Paragraph: consecutive non-blank lines that do not start another block. Tables stay as text.
    const para: string[] = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    blocks.push(paragraph(para.join(" "), cite));
  }
  return { type: "doc", content: blocks };
}
