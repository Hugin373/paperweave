import { describe, expect, it } from "vitest";
import { rankSources, sortCited } from "@/lib/research-sources";
import type { ResearchSource } from "@/lib/types";

const src = (key: string, title: string, year: number, citationCount: number): ResearchSource => ({
  key,
  type: "paper",
  id: `id-${key}`,
  title,
  year,
  citationCount,
});
const sources = [
  src("P1", "Segment Anything", 2023, 9000),
  src("P2", "MedSAM", 2024, 1000),
  src("P3", "SAM-Med3D", 2025, 200),
  src("P4", "U-Net", 2015, 90000),
  src("P5", "Unrelated survey", 2020, 50),
];

const report = `## Overview
Foundation models are adapted to 3D [P1, P3]. Most work fine-tunes SAM [P1].

## Adapting SAM to 3D
SAM-Med3D trains on volumes [P3]. MedSAM fine-tunes on 2D slices [P2] and compares to U-Net [P4].

## Open problems
Evaluation is inconsistent [P3].

## Where to start reading
1. **[P2] MedSAM (2024)** — the clearest example of adapting SAM; start here.
2. [P1] Segment Anything: the base model everything builds on.
3. [P3]
4. **3D adapters [P4] → [P5]:** two ways of lifting 2D models to 3D.

If you want, I can read [P2] in full next.
`;

describe("ranking an assistant report's sources", () => {
  const ranked = rankSources(report, sources);

  it("leads with the suggested reading order and its reasons", () => {
    expect(ranked.startHere.map((s) => s.source.key)).toEqual(["P2", "P1", "P3", "P4", "P5"]);
    expect(ranked.startHere.map((s) => s.reason)).toEqual([
      "the clearest example of adapting SAM; start here.",
      "the base model everything builds on.",
      null,
      "two ways of lifting 2D models to 3D.",
      "two ways of lifting 2D models to 3D.",
    ]);
  });

  it("ranks the other cited sources by how much the report relies on them", () => {
    // Everything cited is in the reading list here, so nothing else is listed or left over.
    expect(ranked.cited).toEqual([]);
    expect(ranked.others).toEqual([]);
  });

  it("ranks by mentions without a reading list, and sorts on request", () => {
    const chat = rankSources(report.split("## Where to start")[0], sources);
    expect(chat.startHere).toEqual([]);
    expect(chat.cited.map((c) => `${c.source.key}:${c.mentions}`)).toEqual(["P3:3", "P1:2", "P2:1", "P4:1"]);
    expect(chat.cited[0].sections).toEqual(["Overview", "Adapting SAM to 3D", "Open problems"]);
    expect(sortCited(chat.cited, "newest").map((c) => c.source.key)).toEqual(["P3", "P2", "P1", "P4"]);
    expect(sortCited(chat.cited, "citations").map((c) => c.source.key)).toEqual(["P4", "P1", "P2", "P3"]);
  });
});
