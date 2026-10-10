/** Maps source-specific publication types onto the app's small shared vocabulary. */
export function normalizePublicationType(raw: string): string {
  const t = raw.toLowerCase().replace(/[\s_-]/g, "");
  if (t === "journalarticle" || t === "article" || t === "journal") return "journal_article";
  if (t === "conference" || t === "proceedingsarticle" || t === "proceedings") return "conference";
  if (t === "preprint" || t === "postedcontent") return "preprint";
  if (t === "review" || t === "metaanalysis") return "review";
  if (t === "book" || t === "booksection" || t === "bookchapter" || t === "monograph") return "book";
  if (t === "dataset") return "dataset";
  if (t === "dissertation") return "dissertation";
  return "other";
}
