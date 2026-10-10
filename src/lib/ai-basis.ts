import type { AiBasis } from "./types";

/** "1–3, 5, 9" from [1, 2, 3, 5, 9]. */
export function pageRanges(numbers: number[]): string {
  const out: string[] = [];
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(", ");
}

const SOURCE_LABEL: Record<Exclude<AiBasis["source"], "abstract">, string> = {
  pdf: "your PDF",
  open_access: "the free open-access copy",
  pmc: "PubMed Central",
};

/** One line saying what an AI answer was based on, e.g. "Read the full text: all 15 pages of your PDF". */
export function describeBasis(b: AiBasis): string {
  if (b.source === "abstract") return "Read the title and abstract only: no PDF or open-access copy was found.";
  const unit = b.unit === "section" ? "section" : "page";
  const from = SOURCE_LABEL[b.source];
  if (b.selection === "relevant") {
    const which = b.included.length === 1 ? `${unit} ${b.included[0]}` : `${unit}s ${pageRanges(b.included)}`;
    const saved = b.source === "open_access" ? ", not saved" : "";
    return `Read ${which} of ${b.total} (the ones matching your question${saved}) from ${from}.`;
  }
  const notes = [
    b.source === "open_access" ? "not saved to your library" : "",
    b.skippedReferences ? "reference list skipped" : "",
    b.condensed ? "long pages shortened to fit" : "",
  ].filter(Boolean);
  const extent =
    b.included.length === b.total ? `all ${b.total} ${unit}s` : `${b.included.length} of ${b.total} ${unit}s`;
  return `Read the full text: ${extent} of ${from}${notes.length ? ` (${notes.join("; ")})` : ""}.`;
}
