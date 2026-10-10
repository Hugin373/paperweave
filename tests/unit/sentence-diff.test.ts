import { describe, expect, it } from "vitest";
import { diffSentences, sentences } from "@/lib/sentence-diff";

describe("sentence diff between versions", () => {
  const v1 = [
    "We propose a method for registration. It is fast on CPUs.",
    "We follow the protocol of prior work. Results: Dice 0.81 on OASIS. We thank reviewers.",
  ];
  const v2 = [
    "We propose a method for registration. It is fast on GPUs and CPUs.",
    "We follow the protocol of prior work. Results: Dice 0.87 on OASIS. We add an ablation on smoothness. We thank reviewers.",
  ];

  it("groups changed, added and removed sentences with their pages", () => {
    const hunks = diffSentences(sentences(v1), sentences(v2));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      removed: [{ text: "It is fast on CPUs.", page: 1 }],
      added: [{ text: "It is fast on GPUs and CPUs.", page: 1 }],
    });
    expect(hunks[1].removed.map((s) => s.text)).toEqual(["Results: Dice 0.81 on OASIS."]);
    expect(hunks[1].added.map((s) => s.text)).toEqual([
      "Results: Dice 0.87 on OASIS.",
      "We add an ablation on smoothness.",
    ]);
  });

  it("finds nothing when only whitespace differs", () => {
    expect(
      diffSentences(
        sentences(["We propose  a method for registration."]),
        sentences(["We propose a method\nfor registration."]),
      ),
    ).toEqual([]);
  });
});
