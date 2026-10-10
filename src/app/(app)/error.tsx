"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/states";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-2xl py-10">
      <ErrorState
        title="This page ran into a problem"
        error="Something unexpected happened while showing this page. Your data is safe — try again, or go back."
        onRetry={reset}
      />
    </div>
  );
}
