import { describe, expect, it } from "vitest";
import { markdownToDoc } from "@/lib/markdown-doc";
import type { ResearchStepKind } from "@/lib/types";
import { citedKeys, parseDecision, runResearchLoop, type ResearchSink } from "@/server/research/agent";
import { SourceRegistry } from "@/server/research/tools";
import type { AIProvider, CompletionRequest } from "@/server/ai/types";

describe("research protocol", () => {
  it("parses decisions, tolerating prose around the JSON and dropping invalid actions", () => {
    const d = parseDecision(
      'Sure! {"thought": "Start broad.", "actions": [{"tool": "search_papers", "query": "depth estimation", "year_from": "2019"}, {"tool": "explode"}, {"tool": "references", "paper": "P2"}, {"tool": "read_paper", "paper": "Q9"}]} done',
    );
    expect(d).toEqual({
      thought: "Start broad.",
      done: false,
      actions: [
        {
          tool: "search_papers",
          query: "depth estimation",
          year_from: 2019,
          year_to: undefined,
          min_citations: undefined,
        },
        { tool: "references", paper: "P2" },
      ],
    });
    // Change actions are part of the protocol too.
    expect(
      parseDecision(
        '{"actions": [{"tool": "create_collection", "name": "Depth", "papers": ["P1"]}, {"tool": "tag_papers", "tags": [], "papers": ["P1"]}]}',
      )?.actions,
    ).toEqual([{ tool: "create_collection", name: "Depth", papers: ["P1"] }]);
    expect(parseDecision('{"thought": "ok", "done": true}')).toMatchObject({ done: true, actions: [] });
    expect(parseDecision("no json here")).toBeNull();
  });

  it("finds cited keys in order", () => {
    expect(citedKeys("A [P2] and [P1, N3]; again [P2] and [P4;P5] but not [X1] or [P]")).toEqual([
      "P2",
      "P1",
      "N3",
      "P4",
      "P5",
    ]);
  });

  it("keeps stable keys per source", () => {
    const r = new SourceRegistry([{ key: "P4", type: "paper", id: "a", title: "A" }]);
    expect(r.add({ type: "paper", id: "a", title: "A again" }).key).toBe("P4");
    expect(r.add({ type: "paper", id: "b", title: "B" }).key).toBe("P5");
    expect(r.add({ type: "note", id: "n", title: "N" }).key).toBe("N1");
    expect(r.get("p5")?.id).toBe("b");
  });
});

describe("research loop", () => {
  class Scripted implements AIProvider {
    readonly kind = "mock" as const;
    readonly model = "scripted";
    calls: CompletionRequest[] = [];
    constructor(private readonly replies: string[]) {}
    async *stream(req: CompletionRequest) {
      this.calls.push(req);
      yield this.replies.shift() ?? "";
    }
  }

  const sink = () => {
    const steps: { kind: ResearchStepKind; label: string; status: string; detail?: string }[] = [];
    let text = "";
    const s: ResearchSink = {
      step: (kind, label) => {
        steps.push({ kind, label, status: "running" });
        return String(steps.length - 1);
      },
      finish: (id, patch) => Object.assign(steps[Number(id)], patch),
      text: (t) => {
        text = t;
      },
      changes: () => {},
    };
    return { s, steps, text: () => text };
  };

  it("reports bad actions to the model, skips repeats, retries invalid JSON and then writes", async () => {
    const provider = new Scripted([
      '{"thought": "Read it.", "actions": [{"tool": "read_paper", "paper": "P9"}]}',
      "not json",
      '{"thought": "Read it again.", "actions": [{"tool": "read_paper", "paper": "P9"}]}',
      "Final answer.",
    ]);
    const out = sink();
    const text = await runResearchLoop({
      provider,
      ctx: { workspaceId: "00000000-0000-0000-0000-000000000000", sources: new SourceRegistry() },
      state: { question: "Q?", mode: "deep", history: [], scopeKeys: [], findings: [], done: [], changes: [] },
      sink: out.s,
      signal: new AbortController().signal,
    });
    expect(text).toBe("Final answer.");
    expect(out.text()).toBe("Final answer.");
    expect(out.steps.map((s) => [s.kind, s.status])).toEqual([
      ["plan", "done"],
      ["read", "error"],
      ["plan", "done"],
      ["write", "done"],
    ]);
    expect(out.steps[1].detail).toContain("P9 is not a known paper key");
    // The failed action was reported to the model in the next round, and the retry asked for JSON.
    expect(provider.calls[1].messages[0].content).toContain("failed (P9 is not a known paper key.)");
    expect(provider.calls[2].messages.at(-1)?.content).toContain("not valid JSON");
    expect(provider.calls[3].system).toContain("assistant writer");
  });

  it("keeps literature tools out of plain chat and tells the model so", async () => {
    const provider = new Scripted([
      '{"thought": "Search.", "actions": [{"tool": "search_papers", "query": "depth estimation"}]}',
      "Reply.",
    ]);
    const out = sink();
    await runResearchLoop({
      provider,
      ctx: { workspaceId: "00000000-0000-0000-0000-000000000000", sources: new SourceRegistry() },
      state: { question: "Q?", mode: "chat", history: [], scopeKeys: [], findings: [], done: [], changes: [] },
      sink: out.s,
      signal: new AbortController().signal,
    });
    expect(provider.calls[0].system).not.toContain('"tool": "search_papers"');
    expect(out.steps.map((s) => s.kind)).toEqual(["plan", "write"]);
    expect(provider.calls[1].messages[0].content).toContain("literature search is off");
  });
});

describe("markdownToDoc", () => {
  it("converts blocks and turns citations into mentions", () => {
    const cite = (k: string) =>
      k === "P1"
        ? { type: "paper" as const, id: "11111111-1111-1111-1111-111111111111", label: "Paper one" }
        : undefined;
    const doc = markdownToDoc(
      "## Overview\n\nDepth is **hard** [P1]; see [P1, P7].\n\n- one *item* [P1]\n- two `code`\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```py\nx = 1\n```\n[docs](https://example.com)",
      cite,
    );
    expect(doc.content?.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "horizontalRule",
      "codeBlock",
      "paragraph",
    ]);
    const para = doc.content![1].content!;
    expect(para).toContainEqual({ type: "text", text: "hard", marks: [{ type: "bold" }] });
    expect(para).toContainEqual({
      type: "mention",
      attrs: { id: "paper:11111111-1111-1111-1111-111111111111", label: "Paper one" },
    });
    // Unknown keys stay as plain text.
    expect(para.at(-1)).toEqual({ type: "text", text: "; see [P1, P7]." });
    expect(doc.content![7].content![0]).toEqual({
      type: "text",
      text: "docs",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });
});
