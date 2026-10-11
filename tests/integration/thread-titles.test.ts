import { describe, expect, it } from "vitest";
import { shortPaperTitle, threadTitle } from "@/server/research/service";

describe("conversation titles", () => {
  it("names a paper by the part before its colon, or its start", () => {
    expect(shortPaperTitle("VIGIL: Tackling Hallucination Detection in Image Recontextualization")).toBe("VIGIL");
    expect(shortPaperTitle("MultiMAE for Brain MRIs: Robustness to Missing Inputs")).toBe("MultiMAE for Brain MRIs");
    expect(shortPaperTitle("Joint Imaging-ROI Representation Learning via Cross-View Contrastive Alignment")).toBe(
      "Joint Imaging-ROI Representation Learning via…",
    );
  });

  it("leads with what the conversation is about, unless the question names it", () => {
    const ask = "Walk me through the paper section by section";
    expect(threadTitle(ask, { papers: ["VIGIL: Tackling Hallucination Detection"], collection: null })).toBe(
      "VIGIL — Walk me through the paper section by section",
    );
    expect(
      threadTitle("Compare their methods", { papers: ["DINO: one", "MAE: two", "JEPA: three"], collection: null }),
    ).toBe("DINO +2 more — Compare their methods");
    expect(threadTitle("What's missing?", { papers: [], collection: "Neuroimaging" })).toBe(
      "Collection: Neuroimaging — What's missing?",
    );
    expect(threadTitle("Summarize VIGIL for me", { papers: ["VIGIL: Tackling…"], collection: null })).toBe(
      "Summarize VIGIL for me",
    );
    expect(threadTitle("What is new in depth estimation?", { papers: [], collection: null })).toBe(
      "What is new in depth estimation?",
    );
  });
});
