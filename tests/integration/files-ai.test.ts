import { eq } from "drizzle-orm";
import { detectLocalServers, forgetDetectedServers } from "@/server/ai/local-detect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deleteAiConfig,
  getAiConfig,
  getAiConfigRow,
  providerForWorkspace,
  saveAiConfig,
  testProvider,
  toConfigDto,
} from "@/server/ai/config";
import { streamCompletion } from "@/server/ai/stream";
import {
  latestPaperResults,
  paperAnalysisRequest,
  paperQuestionRequest,
  rewriteSearchQuery,
  saveAiResult,
  suggestConcepts,
} from "@/server/ai/tasks";
import { AIError } from "@/server/ai/types";
import { db } from "@/server/db/client";
import { paperFilePages, paperFiles } from "@/server/db/schema";
import { createHighlight, deleteHighlight, listHighlights, updateHighlight } from "@/server/files/highlights";
import { deleteFile, extractPdfText, getWorkspaceFile, streamFile, uploadPdf } from "@/server/files/service";
import { ingestPapers } from "@/server/papers/ingest";
import { searchWorkspace } from "@/server/search/workspace-search";
import { savePaper } from "@/server/library/library";
import { createUser, makePdf, paper } from "./helpers";

describe("PDFs, highlights and annotations", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  let paperId: string;
  let fileId: string;

  beforeAll(async () => {
    ctx = await createUser("Reader");
    [paperId] = await ingestPapers([paper({ title: "A paper with a PDF", ids: { s2: "pdf-1" } })]);
    await savePaper(ctx.workspaceId, ctx.userId, paperId);
  });

  it("accepts PDF uploads and rejects other files", async () => {
    const pdf = new File([makePdf("Ordinal depth ranking loss improves relative estimates")], "paper.pdf", {
      type: "application/pdf",
    });
    const row = await uploadPdf(ctx.workspaceId, ctx.userId, paperId, pdf);
    fileId = row.id;
    expect(row.textStatus).toBe("pending");
    // Uploading identical bytes again returns the same file.
    const again = await uploadPdf(ctx.workspaceId, ctx.userId, paperId, pdf);
    expect(again.id).toBe(fileId);
    const html = new File(["<html></html>"], "fake.pdf", { type: "application/pdf" });
    await expect(uploadPdf(ctx.workspaceId, ctx.userId, paperId, html)).rejects.toThrow(/not a valid PDF/);
  });

  it("extracts page text for search", async () => {
    const result = await extractPdfText(fileId);
    expect(result).toEqual({ pages: 1 });
    const pages = await db.select().from(paperFilePages).where(eq(paperFilePages.fileId, fileId));
    expect(pages[0].text).toContain("Ordinal depth ranking loss");
    const res = await searchWorkspace(ctx.workspaceId, "ranking loss");
    expect(res.pdfPages[0]).toMatchObject({ paperId, pageNumber: 1 });
  });

  it("streams files with range support and keeps them private", async () => {
    const file = await getWorkspaceFile(ctx.workspaceId, fileId);
    const res = await streamFile(file, "bytes=0-4");
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("%PDF-");
    const other = await createUser("Outsider");
    await expect(getWorkspaceFile(other.workspaceId, fileId)).rejects.toMatchObject({ status: 404 });
  });

  it("creates, updates and deletes highlights and page notes", async () => {
    const hl = await createHighlight(ctx.workspaceId, ctx.userId, fileId, {
      kind: "highlight",
      pageNumber: 1,
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
      selectedText: "ranking loss",
      prefix: "Ordinal depth ",
      suffix: " improves",
      color: "yellow",
      comment: "",
    });
    await createHighlight(ctx.workspaceId, ctx.userId, fileId, {
      kind: "note",
      pageNumber: 1,
      rects: [{ x: 0.8, y: 0.5, width: 0, height: 0 }],
      selectedText: "",
      prefix: "",
      suffix: "",
      color: "blue",
      comment: "Check the ablation",
    });
    await updateHighlight(ctx.workspaceId, hl.id, { comment: "Key contribution", color: "green" });
    const list = await listHighlights(ctx.workspaceId, fileId);
    expect(list.map((h) => [h.kind, h.color, h.comment])).toEqual([
      ["highlight", "green", "Key contribution"],
      ["note", "blue", "Check the ablation"],
    ]);
    expect((await searchWorkspace(ctx.workspaceId, "ablation")).highlights).toHaveLength(1);
    const other = await createUser("Intruder");
    await expect(deleteHighlight(other.workspaceId, hl.id)).rejects.toMatchObject({ status: 404 });
    await deleteHighlight(ctx.workspaceId, hl.id);
    expect(await listHighlights(ctx.workspaceId, fileId)).toHaveLength(1);
  });

  it("uses PDF text as context for paper questions", async () => {
    const { request: req, basis } = await paperQuestionRequest(
      ctx.workspaceId,
      paperId,
      "What does the ranking loss improve?",
      [],
      64_000,
    );
    expect(basis).toMatchObject({ source: "pdf", selection: "relevant" });
    expect(basis.included).toContain(1);
    expect(req.system).toContain("[Page 1]");
    expect(req.system).toContain("Ordinal depth ranking loss");
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "What does the ranking loss improve?" });
  });

  it("deletes files with their highlights", async () => {
    await deleteFile(ctx.workspaceId, fileId);
    await expect(getWorkspaceFile(ctx.workspaceId, fileId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("what AI tasks read when no PDF is attached", () => {
  let ctx: Awaited<ReturnType<typeof createUser>>;
  afterEach(() => vi.unstubAllGlobals());
  beforeAll(async () => {
    ctx = await createUser("OpenReader");
  });

  it("reads the open-access copy without storing it, and records that with the result", async () => {
    const [id] = await ingestPapers([
      paper({
        title: "An open paper",
        ids: { s2: "oa-read-1" },
        // An IP literal keeps the public-address check offline.
        openAccessPdfUrl: "https://93.184.215.14/open.pdf",
      }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(makePdf("Sparse voxel attention halves memory use"), { status: 200 })),
    );
    const { request, basis } = await paperAnalysisRequest(ctx.workspaceId, id, "summary", 200_000);
    expect(basis).toMatchObject({ source: "open_access", selection: "whole", total: 1, included: [1] });
    expect(request.messages[0].content).toContain("Sparse voxel attention halves memory use");
    expect(request.messages[0].content).toContain("open-access PDF");
    const files = await db.select().from(paperFiles).where(eq(paperFiles.paperId, id));
    expect(files).toHaveLength(0);

    const provider = { kind: "mock" as const, model: "m", stream: async function* () {} };
    await saveAiResult({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      paperId: id,
      kind: "summary",
      content: "S",
      provider,
      basis,
    });
    expect((await latestPaperResults(ctx.workspaceId, id))[0].basis).toEqual(basis);
  });

  it("falls back to the abstract and says so", async () => {
    const [id] = await ingestPapers([paper({ title: "A closed paper", ids: { s2: "closed-1" } })]);
    const { request, basis } = await paperAnalysisRequest(ctx.workspaceId, id, "summary", 200_000);
    expect(basis.source).toBe("abstract");
    expect(request.messages[0].content).toContain("Only the metadata and abstract are available");
  });
});

describe("optional AI configuration", () => {
  it("works only once configured, and never exposes keys", async () => {
    const ctx = await createUser("AiUser");
    await expect(providerForWorkspace(ctx.workspaceId)).rejects.toBeInstanceOf(AIError);

    await saveAiConfig(ctx.workspaceId, ctx.userId, {
      provider: "openai",
      model: "gpt-5",
      apiKey: "sk-secret-value-1234",
    });
    const row = await getAiConfigRow(ctx.workspaceId);
    expect(row?.apiKeyEncrypted).not.toContain("sk-secret");
    const dto = toConfigDto(row);
    expect(dto).toMatchObject({ configured: true, hasApiKey: true, apiKeyLast4: "1234" });
    expect(JSON.stringify(dto)).not.toContain("sk-secret");

    await expect(
      saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "anthropic", model: "claude-opus-5-5" }),
    ).rejects.toThrow(/API key/);
    await expect(
      saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "openai_compatible", model: "x" }),
    ).rejects.toThrow(/base URL/);

    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1" });
    const provider = await providerForWorkspace(ctx.workspaceId);
    expect(await testProvider(provider)).toContain("[mock]");
    const rewritten = await rewriteSearchQuery(provider, "How do VLMs understand 3D spatial relations?");
    expect(rewritten?.query).toBeTruthy();

    const res = await streamCompletion(provider, {
      system: "s",
      messages: [{ role: "user", content: "explain this" }],
    });
    expect(await res.text()).toContain("explain this");

    const [pid] = await ingestPapers([paper({ title: "Concept source", ids: { s2: "ai-1" } })]);
    const concepts = await suggestConcepts(provider, ctx.workspaceId, pid, []);
    expect(concepts[0].name).toBe("Mock concept");

    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "mock", model: "mock-1", enabled: false });
    await expect(providerForWorkspace(ctx.workspaceId)).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("finds the local model on its own and follows what the server runs, or the model picked among several", async () => {
    const ctx = await createUser("LocalModelUser");
    await saveAiConfig(ctx.workspaceId, ctx.userId, {
      provider: "local",
      model: "",
      local: { context: "low", images: true },
    });
    expect(await getAiConfig(ctx.workspaceId)).toMatchObject({
      provider: "local",
      model: "",
      local: { context: "low", images: true },
      localAvailable: true,
    });

    // A model server on port 1234 (nothing on 8000); it lists what `listed` holds.
    let listed = [{ id: "qwen3-8b", max_model_len: 32768 }];
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        urls.push(url);
        if (!url.startsWith("http://127.0.0.1:1234/") && !url.startsWith("http://10.0.0.5:9000/")) {
          throw new TypeError("fetch failed");
        }
        if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: listed });
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        const chunk = {
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "x",
          choices: [{ index: 0, delta: { content: "OK" } }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    try {
      forgetDetectedServers();
      expect(await detectLocalServers()).toEqual([
        { baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "qwen3-8b", contextLength: 32768 }] },
      ]);
      // One model: whatever the server runs.
      const provider = await providerForWorkspace(ctx.workspaceId);
      expect(provider).toMatchObject({ kind: "local", model: "qwen3-8b", local: { context: "low", images: true } });
      expect(await testProvider(provider)).toBe("OK");
      expect(urls.at(-1)).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(bodies[0]).toMatchObject({ model: "qwen3-8b" });

      // Another model loaded there: followed without touching Settings.
      listed = [{ id: "llama-3.1-8b" }] as typeof listed;
      forgetDetectedServers();
      expect((await providerForWorkspace(ctx.workspaceId)).model).toBe("llama-3.1-8b");

      // Several listed: the one picked in Settings, and a clear error until one is.
      listed = [{ id: "a" }, { id: "b" }] as typeof listed;
      forgetDetectedServers();
      await expect(providerForWorkspace(ctx.workspaceId)).rejects.toThrow(/several models/);
      await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "local", model: "b" });
      expect((await providerForWorkspace(ctx.workspaceId)).model).toBe("b");

      // An address under Advanced: only that server.
      await saveAiConfig(ctx.workspaceId, ctx.userId, {
        provider: "local",
        model: "b",
        baseUrl: "http://10.0.0.5:9000",
      });
      expect(await providerForWorkspace(ctx.workspaceId)).toMatchObject({ model: "b" });

      // Nothing running: says so.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
      );
      forgetDetectedServers();
      await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "local", model: "" });
      await expect(providerForWorkspace(ctx.workspaceId)).rejects.toThrow(/No local model server was found/);
    } finally {
      vi.unstubAllGlobals();
      forgetDetectedServers();
    }
  });

  it("remembers settings per provider and supports subscription CLIs without keys", async () => {
    const ctx = await createUser("AiSwitcher");
    await saveAiConfig(ctx.workspaceId, ctx.userId, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      apiKey: "sk-ant-abcd",
    });
    await saveAiConfig(ctx.workspaceId, ctx.userId, {
      provider: "claude_code",
      model: "opus",
      effort: "max",
      apiKey: "ignored",
    });
    expect((await providerForWorkspace(ctx.workspaceId)).kind).toBe("claude_code");
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "codex", model: "" });
    expect(await providerForWorkspace(ctx.workspaceId)).toMatchObject({ kind: "codex", model: "" });

    // Switching back to Anthropic reuses its stored key.
    await saveAiConfig(ctx.workspaceId, ctx.userId, { provider: "anthropic", model: "claude-opus-5-5" });
    const dto = await getAiConfig(ctx.workspaceId);
    expect(dto).toMatchObject({
      provider: "anthropic",
      hasApiKey: true,
      apiKeyLast4: "abcd",
      subscriptionAvailable: true,
    });
    expect(dto.saved.claude_code).toEqual({
      model: "opus",
      effort: "max",
      baseUrl: null,
      hasApiKey: false,
      apiKeyLast4: null,
      local: null,
    });
    expect(dto.effort).toBeNull();
    expect(dto.saved.anthropic).toMatchObject({ model: "claude-opus-5-5", hasApiKey: true });
    expect(JSON.stringify(dto)).not.toContain("sk-ant");

    expect(dto.connected.sort()).toEqual(["anthropic", "claude_code", "codex"]);

    // A model picked while working overrides the default for that request, using the provider's saved settings.
    const picked = await providerForWorkspace(ctx.workspaceId, { provider: "codex", model: "gpt-x", effort: "low" });
    expect(picked).toMatchObject({ kind: "codex", model: "gpt-x" });
    expect((await providerForWorkspace(ctx.workspaceId)).kind).toBe("anthropic");
    await expect(
      providerForWorkspace(ctx.workspaceId, { provider: "ollama", model: "llama3.1", effort: null }),
    ).rejects.toMatchObject({ kind: "not_configured" });

    // Removing the provider forgets its key; other providers' settings stay.
    await deleteAiConfig(ctx.workspaceId);
    const after = await getAiConfig(ctx.workspaceId);
    expect(after.configured).toBe(false);
    expect(after.saved.anthropic).toBeUndefined();
    expect(after.saved.codex).toBeDefined();
  });
});

describe("PDF filenames", () => {
  it("streams a PDF whose filename is not ASCII", async () => {
    const ctx = await createUser("Unicode uploader");
    const [id] = await ingestPapers([paper({ title: "Unicode filename test paper", ids: { s2: "unicode-name" } })]);
    const file = await uploadPdf(ctx.workspaceId, ctx.userId, id, new File([makePdf("Unicode")], "論文.pdf"));
    const res = await streamFile(file, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="__.pdf"; filename*=UTF-8''${encodeURIComponent("論文.pdf")}`,
    );
    await res.body?.cancel();
  });
});
