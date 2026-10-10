"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AiLabel } from "@/components/ai/ai";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";

interface Suggestion {
  name: string;
  description: string;
  existingConceptId: string | null;
}

/** AI-suggested concepts. Nothing is created until the user accepts a suggestion. */
export function ConceptSuggestions({ paperId, linkedIds }: { paperId: string; linkedIds: string[] }) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const res = await api<{ suggestions: Suggestion[] }>(`/api/ai/papers/${paperId}/concepts`, { body: {} });
      setSuggestions(res.suggestions);
    } catch (err) {
      toast.error(errorMessage(err, "Could not get suggestions."));
    } finally {
      setLoading(false);
    }
  };

  const accept = async (s: Suggestion) => {
    try {
      if (s.existingConceptId) {
        await api(`/api/concepts/${s.existingConceptId}/papers`, { body: { paperId } });
      } else {
        await api("/api/concepts", {
          body: { name: s.name, description: s.description, origin: "ai_suggestion", paperId },
        });
      }
      setAdded((a) => new Set(a).add(s.name));
      await Promise.all(["paper", "concepts", "concept", "graph"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!suggestions) {
    return (
      <Button size="sm" variant="ai" onClick={load} loading={loading}>
        <Sparkles />
        Suggest concepts
      </Button>
    );
  }
  return (
    <div className="w-full rounded-lg border border-ai/20 bg-ai-soft/30 p-3">
      <AiLabel />
      {!suggestions.length && <p className="mt-2 text-sm text-muted">No suggestions this time.</p>}
      <ul className="mt-2 space-y-2">
        {suggestions.map((s) => {
          const done = added.has(s.name) || (s.existingConceptId !== null && linkedIds.includes(s.existingConceptId));
          return (
            <li key={s.name} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {s.name}
                  {s.existingConceptId && (
                    <span className="ml-1.5 text-xs font-normal text-subtle">(existing concept)</span>
                  )}
                </p>
                {s.description && <p className="text-[12.5px] text-muted">{s.description}</p>}
              </div>
              <Button size="sm" variant={done ? "ghost" : "secondary"} disabled={done} onClick={() => accept(s)}>
                {done ? <Check /> : <Plus />}
                {done ? "Linked" : s.existingConceptId ? "Link" : "Add"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
