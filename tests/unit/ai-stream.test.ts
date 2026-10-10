import { describe, expect, it } from "vitest";
import { STREAM_ERROR_MARKER, streamCompletion } from "@/server/ai/stream";
import { metaFrame, parseStream } from "@/lib/ai-stream";
import { AIError, type AIProvider } from "@/server/ai/types";

function provider(chunks: string[], failAt?: number, error = new AIError("rate_limited", "slow down")): AIProvider {
  return {
    kind: "mock",
    model: "test",
    async *stream() {
      for (let i = 0; i < chunks.length; i++) {
        if (i === failAt) throw error;
        yield chunks[i];
      }
      if (failAt === chunks.length) throw error;
    },
  };
}

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }] };

describe("AI streaming responses", () => {
  it("streams text and reports completion", async () => {
    let completed = "";
    const res = await streamCompletion(provider(["Hel", "lo"]), req, async (t) => {
      completed = t;
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ai-provider")).toBe("mock");
    expect(await res.text()).toBe("Hello");
    expect(completed).toBe("Hello");
  });

  it("turns failures before the first chunk into JSON errors", async () => {
    const res = await streamCompletion(provider(["x"], 0), req);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "ai_rate_limited", message: "slow down" } });
  });

  it("maps configuration problems to 409", async () => {
    const res = await streamCompletion(provider(["x"], 0, new AIError("not_configured", "set it up")), req);
    expect(res.status).toBe(409);
  });

  it("appends a marker when the stream fails midway", async () => {
    const res = await streamCompletion(provider(["partial ", "more"], 1), req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`partial ${STREAM_ERROR_MARKER}slow down`);
  });
});

describe("AI stream metadata", () => {
  it("sends what the answer is based on first, then progress notes and text", async () => {
    const basis = {
      source: "pdf" as const,
      unit: "page" as const,
      total: 3,
      included: [1, 2, 3],
      selection: "whole" as const,
      skippedReferences: 0,
      condensed: false,
    };
    const slow: AIProvider = {
      kind: "codex",
      model: "test",
      async *stream(r) {
        r.onProgress?.("Thinking");
        await new Promise((resolve) => setTimeout(resolve, 5));
        r.onProgress?.("Reading the methods");
        yield "Answer.";
      },
    };
    let completed = "";
    const res = await streamCompletion(slow, req, async (t) => void (completed = t), { basis });
    const raw = await res.text();
    const parsed = parseStream(raw);
    expect(parsed.text).toBe("Answer.");
    expect(parsed.meta).toEqual([{ basis }, { status: "Thinking" }, { status: "Reading the methods" }]);
    expect(completed).toBe("Answer.");
  });

  it("parses frames split across chunks and ignores an unfinished one", () => {
    const raw = `${metaFrame({ status: "Thinking" })}Hel${metaFrame({ status: "x" }).slice(0, 4)}`;
    expect(parseStream(raw)).toEqual({ text: "Hel", meta: [{ status: "Thinking" }] });
  });

  it("stops the provider when the client goes away", async () => {
    let aborted = false;
    const endless: AIProvider = {
      kind: "mock",
      model: "test",
      async *stream(r) {
        r.signal?.addEventListener("abort", () => (aborted = true));
        for (;;) {
          yield "x";
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      },
    };
    const res = await streamCompletion(endless, req);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });
});
