/**
 * Sentence-level differences between two versions of a document (pages of text), for "what changed
 * between v1 and v3". Sentences are compared after normalizing whitespace; consecutive changes are
 * grouped into hunks with the page they are on.
 */

export interface Sentence {
  text: string;
  page: number;
}

export interface DiffHunk {
  removed: Sentence[];
  added: Sentence[];
}

/** Splits pages into sentences (whitespace normalized; very short fragments such as page numbers dropped). */
export function sentences(pages: string[]): Sentence[] {
  const out: Sentence[] = [];
  pages.forEach((text, i) => {
    for (const s of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[\p{Lu}\d(\[])/u)) {
      const t = s.trim();
      if (t.length >= 12) out.push({ text: t, page: i + 1 });
    }
  });
  return out;
}

const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The hunks that turn `a` into `b` (longest common subsequence of sentences). Large inputs are compared
 * in full; at a few thousand sentences per version this stays well under a second.
 */
export function diffSentences(a: Sentence[], b: Sentence[]): DiffHunk[] {
  const ka = a.map((s) => key(s.text));
  const kb = b.map((s) => key(s.text));
  // Skip the common start and end, which is most of a revised paper.
  let start = 0;
  while (start < ka.length && start < kb.length && ka[start] === kb[start]) start++;
  let endA = ka.length;
  let endB = kb.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > 25_000_000) {
    // Too different to align sentence by sentence: one hunk for the whole changed middle.
    return [{ removed: a.slice(start, endA), added: b.slice(start, endB) }];
  }
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB), flattened.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        ka[start + i] === kb[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  const flush = () => {
    if (current && (current.removed.length || current.added.length)) hunks.push(current);
    current = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[start + i] === kb[start + j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      current ??= { removed: [], added: [] };
      current.added.push(b[start + j]);
      j++;
    } else {
      current ??= { removed: [], added: [] };
      current.removed.push(a[start + i]);
      i++;
    }
  }
  flush();
  return hunks;
}
