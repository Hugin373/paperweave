"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageLoading } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/states";
import { api } from "@/lib/api";

/** Creates a note (optionally attached to a paper) and opens it. */
export function NewNote({ paperId }: { paperId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const started = useRef(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<{ id: string }>("/api/notes", { body: paperId ? { paperId } : {} })
      .then((n) => {
        void qc.invalidateQueries({ queryKey: ["notes"] });
        if (paperId) void qc.invalidateQueries({ queryKey: ["paper"] });
        router.replace(`/notes/${n.id}`);
      })
      .catch(setError);
  }, [paperId, qc, router]);

  if (error) return <ErrorState className="mx-auto max-w-2xl" title="The note could not be created" error={error} />;
  return <PageLoading label="Creating note…" />;
}
