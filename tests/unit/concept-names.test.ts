import { describe, expect, it } from "vitest";
import { conceptKey } from "@/lib/concept-names";

describe("concept name matching", () => {
  it("treats plurals, case, punctuation and abbreviations as the same concept", () => {
    expect(conceptKey("Point clouds")).toBe(conceptKey("point-cloud"));
    expect(conceptKey("Diffusion Models")).toBe(conceptKey("diffusion model"));
    expect(conceptKey("Magnetic resonance imaging")).toBe("mri");
    expect(conceptKey("Magnetic Resonance Imaging (MRI)")).toBe("mri");
    expect(conceptKey("MRIs")).toBe("mri");
    expect(conceptKey("Neural radiance fields")).toBe("nerf");
    expect(conceptKey("Large language models")).toBe("llm");
  });

  it("keeps different concepts apart", () => {
    expect(conceptKey("Segmentation")).not.toBe(conceptKey("Image segmentation"));
    expect(conceptKey("CT")).not.toBe(conceptKey("MRI"));
    expect(conceptKey("Analysis")).toBe("analysis");
    expect(conceptKey("Contrastive learning")).not.toBe(conceptKey("Reinforcement learning"));
  });
});
