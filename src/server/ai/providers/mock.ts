import { AIError, type AIProvider, type CompletionRequest } from "../types";

/**
 * Deterministic provider for automated tests and demos (enabled only with
 * AI_ENABLE_MOCK_PROVIDER=true). It never pretends to be a real model: every answer is
 * prefixed with "[mock]" and simply reflects the request.
 */
export class MockProvider implements AIProvider {
  readonly kind = "mock" as const;
  constructor(readonly model: string) {}

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const last = req.messages.at(-1)?.content ?? "";
    if (/__mock_fail__/.test(last) || this.model === "fail") {
      throw new AIError("unavailable", "The mock provider was asked to fail.");
    }
    if (req.system.startsWith("You screen scientific papers")) {
      // Includes papers whose title mentions "cardiac"; everything else is excluded.
      const title = /Title: (.*)/.exec(last)?.[1] ?? "";
      const include = /cardiac/i.test(title);
      yield JSON.stringify({
        decision: include ? "include" : "exclude",
        reason: `[mock] ${include ? "Meets" : "Does not meet"} the criteria.`,
        evidence: title,
      });
      return;
    }
    if (req.images?.length) {
      yield `[mock] Looked at ${req.images.length} image${req.images.length === 1 ? "" : "s"}.`;
      return;
    }
    if (req.system.startsWith("# Paperweave assistant writer")) {
      const keys = [...new Set(last.match(/^P\d+(?=:)/gm) ?? [])].slice(0, 3);
      const cites = keys.length ? keys.map((k) => `[${k}]`).join(" and ") : "no sources";
      const changes = (last.match(/^- \[(proposed|applied)\]/gm) ?? []).length;
      const text = `## Overview\n\n[mock] Research report based on ${cites}.${changes ? ` [mock] ${changes} workspace changes listed.` : ""}\n`;
      for (const w of text.split(/(?<= )/)) yield w;
      return;
    }
    if (req.system.startsWith("# Paperweave assistant")) {
      // Round 1 gathers (the literature only when search is on); round 2 proposes changes when the
      // user asked to organize papers; then it finishes.
      const question = /<question>([\s\S]*?)<\/question>/.exec(last)?.[1] ?? "research";
      const query = question.replace(/[?]/g, "").split(/\s+/).slice(-3).join(" ");
      const round = Number(/This is round (\d+) of/.exec(last)?.[1] ?? 1);
      const paperKeys = [...new Set(last.match(/^P\d+(?=:)/gm) ?? [])].slice(0, 3);
      if (round === 1) {
        const literature = req.system.includes('"tool": "search_papers"');
        yield JSON.stringify({
          thought: "[mock] Looking at the workspace" + (literature ? " and the literature." : "."),
          actions: literature
            ? [
                { tool: "search_papers", query },
                { tool: "search_library", query },
              ]
            : [{ tool: "search_library", query }, { tool: "list_workspace" }],
        });
      } else if (round === 2 && /collection|organi[sz]e|save/i.test(question)) {
        yield JSON.stringify({
          thought: "[mock] Proposing the requested organization.",
          actions: [
            { tool: "create_collection", name: "Mock collection", papers: paperKeys },
            { tool: "create_concept", name: "Mock concept", description: "[mock] shared idea", papers: paperKeys },
          ],
        });
      } else {
        yield JSON.stringify({ thought: "[mock] Done.", done: true });
      }
      return;
    }
    if (req.system.startsWith("You rank the papers")) {
      // The first cited paper is where to start; the rest alternate high / low.
      const keys = [...new Set(/<papers>([\s\S]*?)<\/papers>/.exec(last)?.[1].match(/^P\d+(?=:)/gm) ?? [])];
      yield JSON.stringify({
        start: keys.slice(0, 1).map((key) => ({ key, why: "[mock] read first" })),
        priority: keys.slice(1).map((key, i) => ({ key, level: i % 2 ? "low" : "high", why: "[mock] ranked" })),
      });
      return;
    }
    if (req.system.startsWith("You suggest literature searches")) {
      yield JSON.stringify({
        related: [{ query: "mock next step search", why: "[mock] extends your library" }],
        neighbouring: [{ query: "mock neighbouring field search", field: "Mock field", why: "[mock] borrowed idea" }],
      });
      return;
    }
    if (/Return JSON/i.test(req.system) && req.system.includes(`"query"`)) {
      const q = /Question:\s*(.+)/.exec(last)?.[1] ?? last;
      yield JSON.stringify({
        query: q.replace(/[?]/g, "").split(/\s+/).slice(-4).join(" "),
        explanation: "[mock] rewritten",
      });
      return;
    }
    if (/Return JSON/i.test(req.system) && req.system.includes(`"concepts"`)) {
      yield JSON.stringify({ concepts: [{ name: "Mock concept", description: "[mock] suggested concept" }] });
      return;
    }
    const words = `[mock] ${last.replace(/\s+/g, " ").slice(0, 160)}`.split(" ");
    for (const w of words) yield `${w} `;
  }
}
