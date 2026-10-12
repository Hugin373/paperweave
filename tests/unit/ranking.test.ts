import { describe, expect, it } from "vitest";
import type { ResearchSource } from "@/lib/types";
import { roundPrompt } from "@/server/research/agent";
import { citedPapers, parseRanking, rankingLine } from "@/server/research/ranking";
import { SourceRegistry } from "@/server/research/tools";
import { ago } from "@/server/research/workspace-tools";

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

describe("ranking in the planner's view of earlier replies", () => {
  it("lists the papers to read first and each priority level", () => {
    expect(
      rankingLine({
        start: [
          { key: "P2", why: null },
          { key: "P4", why: null },
        ],
        priority: [
          { key: "P1", level: "high", why: null },
          { key: "P3", level: "low", why: null },
          { key: "P5", level: "high", why: null },
        ],
      }),
    ).toBe("read first: P2, P4; high: P1, P5; low: P3");
  });

  it("shows it after the reply in the conversation so far", () => {
    const prompt = roundPrompt(
      {
        question: "add the high priority papers",
        mode: "chat",
        history: [{ question: "deep research on X", answer: "Report [P1]", ranking: "read first: P1; high: P2" }],
        scopeKeys: [],
        findings: [],
        done: [],
        changes: [],
      },
      new SourceRegistry(),
      1,
    );
    expect(prompt).toContain(
      "<assistant>Report [P1]</assistant>\n<ranking>Shown with this reply — read first: P1; high: P2</ranking>",
    );
  });
});

describe("when papers were added", () => {
  it("says how long ago, for a planner without a clock", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    expect(ago(before(0.2), now)).toBe("just now");
    expect(ago(before(12), now)).toBe("12 min ago");
    expect(ago(before(180), now)).toBe("3 h ago");
    expect(ago(before(60 * 24 * 5), now)).toBe("5 days ago");
    expect(ago(undefined, now)).toBe("at an unknown time");
  });
});
