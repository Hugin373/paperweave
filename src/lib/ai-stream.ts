import type { AiBasis } from "./types";

/**
 * The text/plain AI stream format shared by the server and the browser: the model's text, with
 * metadata frames (STX + JSON + ETX) interleaved, and an error marker that ends a failed stream.
 */
export const STREAM_ERROR_MARKER = "\u0000AI_ERROR:";
const META_START = "\u0002";
const META_END = "\u0003";

export interface StreamMeta {
  /** What the AI was given to read (sent first). */
  basis?: AiBasis;
  /** A short progress note while the model works, e.g. "Thinking". */
  status?: string;
}

export function metaFrame(meta: StreamMeta): string {
  return `${META_START}${JSON.stringify(meta)}${META_END}`;
}

/** Splits received stream data into the model's text and the complete metadata frames so far. */
export function parseStream(raw: string): { text: string; meta: StreamMeta[] } {
  const meta: StreamMeta[] = [];
  let text = "";
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf(META_START, i);
    if (start < 0) {
      text += raw.slice(i);
      break;
    }
    text += raw.slice(i, start);
    const end = raw.indexOf(META_END, start);
    if (end < 0) break; // incomplete frame: wait for more data
    try {
      meta.push(JSON.parse(raw.slice(start + 1, end)) as StreamMeta);
    } catch {
      /* ignore a malformed frame */
    }
    i = end + 1;
  }
  return { text, meta };
}
