/**
 * The local embedding model (meaning-based search). It is loaded once per process, on first use; the
 * model files are downloaded once into ~/.cache/paperweave/models. Nothing is sent anywhere else.
 */
import { homedir } from "node:os";
import path from "node:path";
import { env } from "@/server/env";

export interface Embedder {
  model: string;
  /** Unit-length vectors for passages (texts to search in). */
  passages(texts: string[]): Promise<number[][]>;
  /** A unit-length vector for a search query. */
  query(text: string): Promise<number[]>;
}

/** How each model family wants its inputs: pooling and the query / passage prefixes it was trained with. */
function modelStyle(model: string) {
  const m = model.toLowerCase();
  if (m.includes("e5")) return { pooling: "mean" as const, query: "query: ", passage: "passage: " };
  if (m.includes("bge"))
    return { pooling: "cls" as const, query: "Represent this sentence for searching relevant passages: ", passage: "" };
  return { pooling: "mean" as const, query: "", passage: "" };
}

const g = globalThis as unknown as { __pwEmbedder?: Promise<Embedder | null>; __pwEmbedderOverride?: Embedder | null };

async function load(model: string): Promise<Embedder> {
  const { pipeline, env: hf } = await import("@huggingface/transformers");
  hf.cacheDir = path.join(homedir(), ".cache", "paperweave", "models");
  const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
  const style = modelStyle(model);
  const run = async (texts: string[]) => {
    const out = await extractor(texts, { pooling: style.pooling, normalize: true });
    return out.tolist() as number[][];
  };
  return {
    model,
    async passages(texts) {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 16)
        vectors.push(...(await run(texts.slice(i, i + 16).map((t) => style.passage + t))));
      return vectors;
    },
    async query(text) {
      return (await run([style.query + text]))[0];
    },
  };
}

/** The embedding model, or null when meaning-based search is off or the model cannot be loaded. */
export function embedder(): Promise<Embedder | null> {
  if (g.__pwEmbedderOverride !== undefined) return Promise.resolve(g.__pwEmbedderOverride);
  if (!env().EMBEDDINGS) return Promise.resolve(null);
  g.__pwEmbedder ??= load(env().EMBEDDING_MODEL).catch((err) => {
    console.warn("[embeddings] the model could not be loaded; search matches words only", err);
    // Try again later (e.g. the first download failed while offline).
    setTimeout(() => (g.__pwEmbedder = undefined), 10 * 60_000).unref();
    return null;
  });
  return g.__pwEmbedder;
}

/** Tests replace the model with a deterministic one (or null to turn it off). */
export function setEmbedderForTests(e: Embedder | null | undefined) {
  g.__pwEmbedderOverride = e;
}
