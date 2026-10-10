import { metaFrame, STREAM_ERROR_MARKER, type StreamMeta } from "@/lib/ai-stream";
import { AIError, type AIProvider, type CompletionRequest } from "./types";

export { STREAM_ERROR_MARKER };

const STATUS: Record<AIError["kind"], number> = {
  not_configured: 409,
  auth: 502,
  rate_limited: 429,
  unavailable: 502,
  timeout: 504,
  refused: 422,
  bad_request: 502,
};

export function aiErrorResponse(err: AIError): Response {
  return Response.json({ error: { code: `ai_${err.kind}`, message: err.message } }, { status: STATUS[err.kind] });
}

function toAiError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new AIError("timeout", "The AI provider took too long to respond.");
  }
  console.error("[ai] unexpected provider failure", err);
  return new AIError("unavailable", "The AI provider failed unexpectedly.");
}

type StreamEvent = { text: string } | { status: string };

/**
 * Runs the provider and yields its text together with the progress notes it reports, in order.
 * Stopping early aborts the provider (e.g. kills a CLI process).
 */
async function* withProgress(provider: AIProvider, req: CompletionRequest): AsyncGenerator<StreamEvent> {
  const abort = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, abort.signal]) : abort.signal;
  const queue: StreamEvent[] = [];
  // Resolves the consumer's wait when an event arrives or the provider finishes.
  const waiting: { wake: (() => void) | null } = { wake: null };
  let finished = false;
  let failure: unknown = null;
  const push = (e: StreamEvent) => {
    queue.push(e);
    waiting.wake?.();
  };
  void (async () => {
    try {
      for await (const text of provider.stream({ ...req, signal, onProgress: (status) => push({ status }) })) {
        push({ text });
      }
    } catch (err) {
      failure = err;
    } finally {
      finished = true;
      waiting.wake?.();
    }
  })();
  try {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => (waiting.wake = resolve));
      waiting.wake = null;
    }
  } finally {
    if (!finished) abort.abort();
  }
}

/**
 * Streams provider output as text/plain (see src/lib/ai-stream.ts for the format). The first event
 * is awaited before responding so that configuration/auth failures become proper JSON errors;
 * failures after streaming has begun are appended using STREAM_ERROR_MARKER. `meta` (what the
 * answer is based on) is sent first, then progress notes and text. `onComplete` receives the text.
 */
export async function streamCompletion(
  provider: AIProvider,
  req: CompletionRequest,
  onComplete?: (text: string) => Promise<void>,
  meta?: StreamMeta,
): Promise<Response> {
  const events = withProgress(provider, req);
  let first: IteratorResult<StreamEvent>;
  try {
    first = await events.next();
  } catch (err) {
    return aiErrorResponse(toAiError(err));
  }
  const encoder = new TextEncoder();
  let full = "";
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (meta) controller.enqueue(encoder.encode(metaFrame(meta)));
        let step = first;
        while (!step.done) {
          const ev = step.value;
          if ("text" in ev) {
            full += ev.text;
            controller.enqueue(encoder.encode(ev.text));
          } else {
            controller.enqueue(encoder.encode(metaFrame({ status: ev.status })));
          }
          step = await events.next();
        }
        if (onComplete && full.trim()) await onComplete(full);
      } catch (err) {
        controller.enqueue(encoder.encode(`${STREAM_ERROR_MARKER}${toAiError(err).message}`));
      } finally {
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-AI-Provider": provider.kind,
      "X-AI-Model": provider.model,
    },
  });
}
