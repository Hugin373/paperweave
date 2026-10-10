import { api, qs } from "@/lib/api";

export type LinkTargetType = "paper" | "concept" | "note";

export interface LinkTarget {
  type: LinkTargetType;
  id: string;
  label: string;
  detail: string | null;
}

export function fetchLinkTargets(q: string, opts: { types?: LinkTargetType[]; exclude?: string } = {}) {
  return api<LinkTarget[]>(`/api/link-targets${qs({ q, types: opts.types?.join(","), exclude: opts.exclude })}`);
}

export function hrefFor(type: LinkTargetType, id: string) {
  return type === "paper" ? `/papers/${id}` : type === "concept" ? `/concepts/${id}` : `/notes/${id}`;
}

export const TYPE_LABEL: Record<LinkTargetType, string> = { paper: "Paper", concept: "Concept", note: "Note" };
