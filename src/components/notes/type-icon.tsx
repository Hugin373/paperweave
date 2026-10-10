import { FileText, Lightbulb, NotebookPen } from "lucide-react";
import { cn } from "@/lib/cn";
import type { LinkTargetType } from "./link-targets";

const COLOR: Record<LinkTargetType, string> = {
  paper: "text-[var(--node-paper)]",
  concept: "text-[var(--node-concept)]",
  note: "text-[var(--node-note)]",
};

export function TypeIcon({ type, className }: { type: LinkTargetType; className?: string }) {
  const Icon = type === "paper" ? FileText : type === "concept" ? Lightbulb : NotebookPen;
  return <Icon className={cn("size-4 shrink-0", COLOR[type], className)} aria-hidden />;
}
