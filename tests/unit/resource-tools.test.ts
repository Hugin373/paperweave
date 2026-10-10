import { describe, expect, it } from "vitest";
import { classifyUrl, evaluate, htmlToText, resourceLinks } from "@/server/research/resource-tools";

describe("research resources", () => {
  it("recognises code, datasets, models and data repositories, normalising repository links", () => {
    expect(classifyUrl("https://github.com/owner/repo/tree/main/src")).toEqual({
      kind: "code",
      url: "https://github.com/owner/repo",
    });
    expect(classifyUrl("https://huggingface.co/datasets/org/brains")?.kind).toBe("dataset");
    expect(classifyUrl("https://huggingface.co/org/model-7b")?.kind).toBe("model");
    expect(classifyUrl("https://zenodo.org/records/123")?.kind).toBe("data");
    expect(classifyUrl("https://someone.github.io/project/")).toEqual({
      kind: "project page",
      url: "https://someone.github.io/project",
    });
    expect(classifyUrl("https://doi.org/10.1000/x")).toBeNull();
  });

  it("finds resource links in paper text with their page, also when a line break splits them", () => {
    const links = resourceLinks([
      { n: 1, text: "Code is available at https://github.com/ owner/repo." },
      { n: 7, text: "Data: huggingface.co/datasets/org/brains, see also https://github.com/owner/repo/issues." },
    ]);
    expect(links).toEqual([
      { kind: "code", url: "https://github.com/owner/repo", page: 1 },
      { kind: "dataset", url: "https://huggingface.co/datasets/org/brains", page: 7 },
    ]);
  });

  it("turns a web page into its visible text", () => {
    expect(htmlToText("<html><script>x()</script><h1>Title</h1><p>A &amp; B</p></html>")).toBe("Title\nA & B");
  });

  it("calculates exactly, and refuses anything that is not arithmetic", () => {
    expect(evaluate("7e9 * 2 / 1G")).toBe(14);
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("-(4k + 1_000) / 2")).toBe(-2500);
    expect(evaluate("ceil(log2(1000)) + max(1, 2, 3)")).toBe(13);
    expect(() => evaluate("process.exit()")).toThrow(/unknown name/);
    expect(() => evaluate("1 / 0")).toThrow(/finite/);
  });
});
