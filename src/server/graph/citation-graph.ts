/**
 * Citation neighborhood of a paper: its most-cited references and citing papers, plus any
 * citation edges among them that are already known. All edges come from scholarly sources.
 */
import type { CitationGraphResponse, GraphEdge, GraphNode, PaperSummary } from "@/lib/types";
import { edgesAmong, syncCitationPage, CITATION_PAGE, REFERENCE_PAGE } from "@/server/papers/citations";
import { getPaperSummaries, getVisiblePaper } from "@/server/papers/service";
import { ScholarlyUnavailableError } from "@/server/scholarly/service";

function node(p: PaperSummary, role: GraphNode["role"]): GraphNode {
  const first = p.authors[0]?.split(/\s+/).at(-1);
  return {
    id: `paper:${p.id}`,
    type: "paper",
    entityId: p.id,
    label: p.title,
    sublabel: [first ? (p.authors.length > 1 ? `${first} et al.` : first) : null, p.year].filter(Boolean).join(", "),
    status: p.library?.status ?? null,
    citationCount: p.citationCount,
    year: p.year,
    role,
  };
}

const byCitations = (a: { citationCount: number | null }, b: { citationCount: number | null }) =>
  (b.citationCount ?? -1) - (a.citationCount ?? -1);

export async function citationGraph(
  workspaceId: string,
  paperId: string,
  opts: { references: number; citations: number },
): Promise<CitationGraphResponse> {
  await getVisiblePaper(workspaceId, paperId);
  let partial = false;
  const fetchSide = async (direction: "references" | "citations") => {
    try {
      const limit = direction === "references" ? REFERENCE_PAGE : CITATION_PAGE;
      const { resolved } = await syncCitationPage(paperId, direction, 0, limit);
      return resolved.map((r) => r.id);
    } catch (err) {
      if (err instanceof ScholarlyUnavailableError) {
        partial = true;
        return [];
      }
      throw err;
    }
  };
  const [refIds, citeIds] = await Promise.all([fetchSide("references"), fetchSide("citations")]);
  const summaries = await getPaperSummaries(workspaceId, [paperId, ...refIds, ...citeIds]);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const center = byId.get(paperId)!;

  const topRefs = [...new Set(refIds)]
    .map((id) => byId.get(id))
    .filter((p): p is PaperSummary => !!p && p.id !== paperId)
    .sort(byCitations)
    .slice(0, opts.references);
  const refSet = new Set(topRefs.map((p) => p.id));
  const topCites = [...new Set(citeIds)]
    .map((id) => byId.get(id))
    .filter((p): p is PaperSummary => !!p && p.id !== paperId && !refSet.has(p.id))
    .sort(byCitations)
    .slice(0, opts.citations);

  const nodes: GraphNode[] = [
    node(center, "center"),
    ...topRefs.map((p) => node(p, "reference")),
    ...topCites.map((p) => node(p, "citation")),
  ];
  const ids = nodes.map((n) => n.entityId);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (citing: string, cited: string) => {
    const id = `cites:paper:${citing}->paper:${cited}`;
    if (seen.has(id) || citing === cited) return;
    seen.add(id);
    edges.push({ id, type: "cites", source: `paper:${citing}`, target: `paper:${cited}` });
  };
  for (const p of topRefs) push(paperId, p.id);
  for (const p of topCites) push(p.id, paperId);
  for (const e of await edgesAmong(ids)) push(e.citing, e.cited);

  const papers: Record<string, PaperSummary> = {};
  for (const n of nodes) papers[n.entityId] = byId.get(n.entityId)!;
  return {
    nodes,
    edges,
    truncated: refIds.length > topRefs.length || citeIds.length > topCites.length,
    papers,
    partial,
  };
}
