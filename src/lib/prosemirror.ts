/**
 * Helpers for the ProseMirror/TipTap JSON documents used by notes.
 *
 * Links to other knowledge objects are "mention" nodes whose `id` attribute is
 * "<type>:<uuid>" (type = paper | concept | note) and whose `label` is the display text.
 */

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export type MentionType = "paper" | "concept" | "note";

export const EMPTY_DOC: PMNode = { type: "doc", content: [] };

export function parseMentionId(id: unknown): { type: MentionType; id: string } | null {
  if (typeof id !== "string") return null;
  const m = /^(paper|concept|note):([0-9a-f-]{36})$/i.exec(id);
  return m ? { type: m[1].toLowerCase() as MentionType, id: m[2].toLowerCase() } : null;
}

export function walk(node: PMNode | undefined, visit: (n: PMNode) => void) {
  if (!node) return;
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

export function extractMentions(doc: PMNode): Record<MentionType, string[]> {
  const out: Record<MentionType, Set<string>> = { paper: new Set(), concept: new Set(), note: new Set() };
  walk(doc, (n) => {
    if (n.type !== "mention") return;
    const parsed = parseMentionId(n.attrs?.id);
    if (parsed) out[parsed.type].add(parsed.id);
  });
  return { paper: [...out.paper], concept: [...out.concept], note: [...out.note] };
}

const BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "tableRow",
  "detailsSummary",
]);

export function docToPlainText(doc: PMNode): string {
  const parts: string[] = [];
  const visit = (n: PMNode) => {
    if (n.type === "text") parts.push(n.text ?? "");
    else if (n.type === "mention") parts.push(String(n.attrs?.label ?? ""));
    else if (n.type === "hardBreak") parts.push("\n");
    for (const c of n.content ?? []) visit(c);
    if (BLOCKS.has(n.type)) parts.push("\n");
  };
  visit(doc);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inlineMarkdown(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      if (n.type === "mention") return `[[${String(n.attrs?.label ?? "")}]]`;
      if (n.type !== "text") return inlineMarkdown(n.content);
      let t = n.text ?? "";
      const marks = new Set((n.marks ?? []).map((m) => m.type));
      if (marks.has("code")) t = `\`${t}\``;
      if (marks.has("bold")) t = `**${t}**`;
      if (marks.has("italic")) t = `*${t}*`;
      if (marks.has("strike")) t = `~~${t}~~`;
      if (marks.has("highlight")) t = `==${t}==`;
      if (marks.has("underline")) t = `<u>${t}</u>`;
      const link = n.marks?.find((m) => m.type === "link");
      if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href)})`;
      return t;
    })
    .join("");
}

function blockMarkdown(node: PMNode, indent = ""): string {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).map((c) => blockMarkdown(c, indent)).join("\n\n");
    case "paragraph":
      return indent + inlineMarkdown(node.content);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inlineMarkdown(node.content)}`;
    case "blockquote":
      return (node.content ?? [])
        .map((c) => blockMarkdown(c))
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "codeBlock":
      return `\`\`\`${String(node.attrs?.language ?? "")}\n${(node.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\``;
    case "callout":
      return (node.content ?? [])
        .map((c) => blockMarkdown(c))
        .join("\n\n")
        .split("\n")
        .map((l, i) => (i === 0 ? `> 💡 ${l}` : `> ${l}`))
        .join("\n");
    case "details": {
      const summary = node.content?.find((c) => c.type === "detailsSummary");
      const body = node.content?.find((c) => c.type === "detailsContent");
      const inner = (body?.content ?? []).map((c) => blockMarkdown(c)).join("\n\n");
      return `<details>\n<summary>${inlineMarkdown(summary?.content)}</summary>\n\n${inner}\n\n</details>`;
    }
    case "table": {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((c) => inlineMarkdown(c.content))
            .join(" ")
            .replace(/\|/g, "\\|"),
        ),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
      return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
    }
    case "horizontalRule":
      return "---";
    case "bulletList":
    case "orderedList":
    case "taskList":
      return (node.content ?? [])
        .map((item, i) => {
          const bullet =
            node.type === "orderedList"
              ? `${i + 1}.`
              : node.type === "taskList"
                ? `- [${item.attrs?.checked ? "x" : " "}]`
                : "-";
          const [first, ...rest] = item.content ?? [];
          const head = `${indent}${bullet} ${first ? blockMarkdown(first).trimStart() : ""}`;
          const tail = rest.map((c) => blockMarkdown(c, indent + "  ")).join("\n");
          return tail ? `${head}\n${tail}` : head;
        })
        .join("\n");
    default:
      return inlineMarkdown(node.content);
  }
}

export function docToMarkdown(doc: PMNode): string {
  return (
    blockMarkdown(doc)
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

/** Builds a minimal document from plain text (used for imports and AI insertions). */
export function textToDoc(text: string): PMNode {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  };
}

export function isDoc(value: unknown): value is PMNode {
  return !!value && typeof value === "object" && (value as PMNode).type === "doc";
}
