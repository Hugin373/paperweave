import { describe, expect, it } from "vitest";
import {
  docToMarkdown,
  docToPlainText,
  extractMentions,
  parseMentionId,
  textToDoc,
  type PMNode,
} from "@/lib/prosemirror";

const C = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const N = "33333333-3333-4333-8333-333333333333";

const doc: PMNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Depth" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "See " },
        { type: "mention", attrs: { id: `concept:${C}`, label: "Metric depth" } },
        { type: "text", text: " and " },
        { type: "mention", attrs: { id: `paper:${P}`, label: "Depth Anything" } },
        { type: "text", text: " (", marks: [] },
        { type: "text", text: "important", marks: [{ type: "bold" }] },
        { type: "text", text: ")." },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "mention", attrs: { id: `note:${N}`, label: "Reading log" } }] },
          ],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "second", marks: [{ type: "italic" }] }] }],
        },
      ],
    },
    { type: "mention", attrs: { id: "concept:not-a-uuid", label: "bad" } },
  ],
};

describe("note documents", () => {
  it("parses mention ids", () => {
    expect(parseMentionId(`paper:${P}`)).toEqual({ type: "paper", id: P });
    expect(parseMentionId("paper:123")).toBeNull();
    expect(parseMentionId(42)).toBeNull();
  });

  it("extracts unique, valid mentions", () => {
    expect(extractMentions(doc)).toEqual({ paper: [P], concept: [C], note: [N] });
  });

  it("projects plain text including mention labels", () => {
    const text = docToPlainText(doc);
    expect(text).toContain("Depth");
    expect(text).toContain("See Metric depth and Depth Anything (important).");
    expect(text).toContain("Reading log");
  });

  it("serializes Markdown with wiki-links", () => {
    const md = docToMarkdown(doc);
    expect(md).toContain("## Depth");
    expect(md).toContain("See [[Metric depth]] and [[Depth Anything]] (**important**).");
    expect(md).toContain("- [[Reading log]]");
    expect(md).toContain("- *second*");
  });

  it("builds documents from text", () => {
    expect(textToDoc("a\n\nb").content).toHaveLength(2);
  });
});

describe("Notion-style blocks", () => {
  const p = (text: string): PMNode => ({ type: "paragraph", content: [{ type: "text", text }] });
  const blocks: PMNode = {
    type: "doc",
    content: [
      { type: "callout", content: [p("Key takeaway")] },
      {
        type: "details",
        content: [
          { type: "detailsSummary", content: [{ type: "text", text: "Proof sketch" }] },
          { type: "detailsContent", content: [p("By induction.")] },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [p("Model")] },
              { type: "tableHeader", content: [p("AbsRel")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [p("Depth Anything")] },
              { type: "tableCell", content: [p("0.076")] },
            ],
          },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "important", marks: [{ type: "highlight" }] }] },
    ],
  };

  it("exports callouts, toggles, tables and highlights to Markdown", () => {
    const md = docToMarkdown(blocks);
    expect(md).toContain("> 💡 Key takeaway");
    expect(md).toContain("<summary>Proof sketch</summary>");
    expect(md).toContain("By induction.");
    expect(md).toContain("| Model | AbsRel |\n| --- | --- |\n| Depth Anything | 0.076 |");
    expect(md).toContain("==important==");
  });

  it("includes their text in the searchable projection", () => {
    const text = docToPlainText(blocks);
    expect(text).toContain("Key takeaway");
    expect(text).toContain("Proof sketch");
    expect(text).toContain("Depth Anything");
  });
});
