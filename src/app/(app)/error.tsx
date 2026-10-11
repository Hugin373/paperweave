"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/states";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    // Also to the server log: on a phone there is no console to look at.
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: String(error?.message ?? error).slice(0, 2000),
        stack: error?.stack?.slice(0, 8000),
        digest: error?.digest,
        url: window.location.href,
      }),
    }).catch(() => {});
  }, [error]);
  return (
    <div className="mx-auto max-w-2xl space-y-3 py-10">
      <ErrorState
        title="This page ran into a problem"
        error="Something unexpected happened while showing this page. Your data is safe — try again, or go back."
        onRetry={reset}
      />
      <details className="rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] text-muted">
        <summary className="cursor-pointer select-none">Technical details</summary>
        <p className="mt-2 font-mono break-words whitespace-pre-wrap">
          {String(error?.message ?? error)}
          {error?.digest ? `\n(digest ${error.digest})` : ""}
        </p>
      </details>
    </div>
  );
}
