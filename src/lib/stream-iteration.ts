/**
 * `for await (const chunk of readableStream)` for browsers without it (Safari, as of 26.3). pdf.js reads page
 * text that way, so without this the reader crashes on iPhones. The same fallback is in the PDF worker's
 * entry (scripts/copy-pdf-worker.mjs).
 */
type Iterable = ReadableStream & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

if (typeof ReadableStream !== "undefined" && !(ReadableStream.prototype as Iterable)[Symbol.asyncIterator]) {
  (ReadableStream.prototype as Iterable)[Symbol.asyncIterator] = async function* (this: ReadableStream) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

export {};
