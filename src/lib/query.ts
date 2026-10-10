/**
 * Deterministic handling of natural-language research questions, used when no AI provider is
 * configured (and as the baseline when one is). Strips question scaffolding and filler words
 * so the scholarly search engines receive the content-bearing terms.
 */

const QUESTION_PREFIX =
  /^(how|what|why|which|who|when|where|whether|is|are|does|do|did|can|could|should|would|will|has|have|to what extent|in what ways?)\b/i;

const FILLER = new Set(
  `a an the of in on at to for from by with about into over under between among and or but if then than
  so as is are was were be been being do does did doing done can could should would will shall may might must
  how what why which who whom whose when where whether well good better best current currently recent recently
  really actually exactly truly much many more most some any there their they them it its this that these those
  i me my we our you your papers paper research studies study work works literature find show tell about know
  understand understanding approach approaches existing state art`.split(/\s+/),
);

export function looksLikeQuestion(q: string): boolean {
  const t = q.trim();
  return t.endsWith("?") || (QUESTION_PREFIX.test(t) && t.split(/\s+/).length >= 4);
}

export function keywordsFromQuestion(q: string): string {
  const tokens = q
    .replace(/[?!.,;:()"“”]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Hyphenated terms and terms with digits ("vision-language", "3D") are always kept.
  const kept = tokens.filter((tok) => tok.includes("-") || /\d/.test(tok) || !FILLER.has(tok.toLowerCase()));
  const result = kept.join(" ").trim();
  // Fall back to the original text if we stripped (almost) everything.
  return result.split(/\s+/).length >= 2 ? result : q.replace(/[?]/g, "").trim();
}

/** Returns the query that should be sent to scholarly search engines. */
export function interpretQuery(q: string): { query: string; rewritten: boolean } {
  if (!looksLikeQuestion(q)) return { query: q.trim(), rewritten: false };
  const query = keywordsFromQuestion(q);
  return { query, rewritten: query !== q.trim() };
}
