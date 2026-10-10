import { describe, expect, it } from "vitest";
import type { ResearchSource } from "@/lib/types";
import { citedPapers, parseRanking } from "@/server/research/ranking";

const paper = (key: string): ResearchSource => ({ key, type: "paper", id: `id-${key}`, title: `Paper ${key}` });
const papers = ["P1", "P2", "P3", "P4"].map(paper);

describe("AI source ranking", () => {
  it("keeps valid entries, drops unknown and repeated keys, and adds papers it left out", () => {
    const raw = `Here you go:
{"start": [{"key": "p2", "why": "  the clearest overview  "}, {"key": "P9", "why": "invented"}],
 "priority": [{"key": "P1", "level": "High", "why": "main baseline"}, {"key": "P2", "level": "low"},
              {"key": "P3", "level": "essential", "why": "x"}]}`;
    expect(parseRanking(raw, papers)).toEqual({
      start: [{ key: "P2", why: "the clearest overview" }],
      priority: [
        { key: "P1", level: "high", why: "main baseline" },
        { key: "P3", level: "medium", why: "x" },
        { key: "P4", level: "medium", why: null },
      ],
    });
  });

  it("returns null for replies that are not a usable ranking", () => {
    expect(parseRanking("I cannot rank these.", papers)).toBeNull();
    expect(parseRanking('{"start": "P1"}', papers)).toBeNull();
    expect(parseRanking('{"start": [{"key": "P9"}], "priority": []}', papers)).toBeNull();
  });

  it("ranks only cited papers, not notes", () => {
    const sources = [...papers, { key: "N1", type: "note" as const, id: "n", title: "My note" }];
    expect(citedPapers("See [P3, N1] and [P1].", sources).map((s) => s.key)).toEqual(["P3", "P1"]);
  });
});
