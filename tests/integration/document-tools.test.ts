import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AIProvider, CompletionRequest } from "@/server/ai/types";
import { extractPdfText, uploadPdf } from "@/server/files/service";
import { ingestPapers } from "@/server/papers/ingest";
import { toolFor } from "@/server/research/agent";
import { SourceRegistry } from "@/server/research/tools";
import type { ScholarlyProvider } from "@/server/scholarly/types";
import { createUser, installFakeScholarly, makePdfPages, paper } from "./helpers";

// Host names resolve to a public address without the network.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

describe("looking at pages and versions", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  const sources = new SourceRegistry();
  afterEach(() => vi.unstubAllGlobals());

  beforeAll(async () => {
    ctx = await createUser("Document viewer");
    const arxiv: ScholarlyProvider = {
      name: "arxiv",
      lookupKinds: ["arxiv"],
      supportsSearch: false,
      supportsCitations: false,
      getPaper: async () => null,
      latestVersion: async () => 2,
    };
    await installFakeScholarly(arxiv);
    const [withPdf, onArxiv] = await ingestPapers([
      paper({ title: "A paper with a figure on page two", ids: { s2: "doc-1" } }),
      paper({ title: "A preprint revised once", ids: { arxiv: "2402.00009" } }),
    ]);
    const file = await uploadPdf(
      ctx.workspaceId,
      ctx.userId,
      withPdf,
      new File([makePdfPages([["Introduction text."], ["Figure 3: accuracy over epochs."]])], "fig.pdf"),
    );
    await extractPdfText(file.id);
    sources.add({ type: "paper", id: withPdf, title: "A paper with a figure on page two" });
    sources.add({ type: "paper", id: onArxiv, title: "A preprint revised once" });
  });

  it("sends the page as an image, with its text, to the AI", async () => {
    const seen: CompletionRequest[] = [];
    const provider: AIProvider = {
      kind: "mock",
      model: "vision",
      async *stream(req) {
        seen.push(req);
        yield "A line plot of accuracy rising over 10 epochs.";
      },
    };
    const r = await toolFor(
      { tool: "view_page", paper: "P1", page: 2, question: "What does Figure 3 show?" },
      sources,
    ).run({
      workspaceId: ctx.workspaceId,
      sources,
      provider,
    });
    expect(r.report).toContain("A line plot of accuracy rising over 10 epochs.");
    const png = Buffer.from(seen[0].images![0].data, "base64");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(seen[0].messages[0].content).toContain("Figure 3: accuracy over epochs.");

    const missing = await toolFor({ tool: "view_page", paper: "P1", page: 9 }, sources)
      .run({ workspaceId: ctx.workspaceId, sources, provider })
      .catch((e: Error) => e);
    expect(String(missing)).toMatch(/has 2 pages/);
  });

  it("lists what changed between two arXiv versions, with pages", async () => {
    const pdfs: Record<string, Uint8Array> = {
      "https://arxiv.org/pdf/2402.00009v1": makePdfPages([["We study registration.", "Our Dice score is 0.81."]]),
      "https://arxiv.org/pdf/2402.00009v2": makePdfPages([
        ["We study registration.", "Our Dice score is 0.87."],
        ["We added an ablation study."],
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const body = pdfs[String(input)];
        return body ? new Response(body.slice(), { status: 200 }) : new Response("nope", { status: 404 });
      }),
    );
    const r = await toolFor({ tool: "compare_versions", paper: "P2" }, sources).run({
      workspaceId: ctx.workspaceId,
      sources,
    });
    expect(r.report).toContain("v1 (1 pages) → v2 (2 pages");
    expect(r.report).toContain("changed: “Our Dice score is 0.81.” → “Our Dice score is 0.87.");
    expect(r.report).toContain("We added an ablation study.");
  });

  it("finds a paper's code and models, and reads a repository", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const responses: Record<string, () => Response> = {
      "https://huggingface.co/api/papers/2402.00009": () => json({ githubRepo: "https://github.com/owner/repo" }),
      "https://huggingface.co/api/arxiv/2402.00009/repos": () =>
        json({ models: [{ id: "org/reg-model", downloads: 50 }], datasets: [], spaces: [] }),
      "https://api.github.com/repos/owner/repo": () =>
        json({
          full_name: "owner/repo",
          description: "Official code",
          stargazers_count: 1234,
          pushed_at: "2026-09-01T00:00:00Z",
          archived: false,
          default_branch: "main",
          license: { spdx_id: "MIT" },
        }),
      "https://api.github.com/repos/owner/repo/readme": () =>
        new Response("# Repo\nTrain with `python train.py --gpus 1`."),
      "https://api.github.com/repos/owner/repo/contents": () =>
        json([
          { name: "configs", type: "dir" },
          { name: "requirements.txt", type: "file" },
        ]),
      "https://api.github.com/repos/owner/repo/contents/configs/train.yaml": () =>
        new Response("batch_size: 8\nlr: 0.001"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => responses[String(input)]?.() ?? new Response("nope", { status: 404 })),
    );
    const run = (action: Parameters<typeof toolFor>[0]) =>
      toolFor(action, sources).run({ workspaceId: ctx.workspaceId, sources });

    const found = await run({ tool: "find_resources", paper: "P2" });
    expect(found.report).toContain("- code: https://github.com/owner/repo — given on the paper's Hugging Face page");
    expect(found.report).toContain("- model: https://huggingface.co/org/reg-model");

    const repo = await run({ tool: "read_resource", url: "https://github.com/owner/repo" });
    expect(repo.report).toContain("1,234 stars");
    expect(repo.report).toContain("license MIT");
    expect(repo.report).toContain("Top-level files: configs/, requirements.txt");
    expect(repo.report).toContain("python train.py --gpus 1");

    const config = await run({
      tool: "read_resource",
      url: "https://github.com/owner/repo",
      path: "configs/train.yaml",
    });
    expect(config.report).toContain("batch_size: 8");
  });
});
