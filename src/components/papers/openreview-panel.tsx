"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageSquareText } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { OpenReviewInfoDto } from "@/lib/types";

/** The first number in a rating like "6: marginally above the acceptance threshold". */
const score = (rating: string | null) => {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(rating ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * The paper's OpenReview record (ML venues): where it was submitted and the outcome, plus the
 * reviewers' ratings and summaries when an OpenReview account is configured on the server.
 */
export function OpenReviewPanel({ paperId }: { paperId: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const { data } = useQuery({
    queryKey: ["paper", paperId, "openreview"],
    queryFn: () => api<OpenReviewInfoDto | { forumId: null }>(`/api/papers/${paperId}/openreview`),
    staleTime: 60 * 60_000,
    retry: false,
  });
  if (!data?.forumId) return null;
  const info = data as OpenReviewInfoDto;
  const scores = info.reviews.map((r) => score(r.rating)).filter((s): s is number => s !== null);
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  return (
    <section aria-labelledby="openreview-title">
      <h2 id="openreview-title" className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">
        Peer review
      </h2>
      <div className="space-y-2 text-[13px]">
        <p>
          <span className="font-medium">{info.decision ?? info.venue ?? "On OpenReview"}</span>
          {info.decision && info.venue && <span className="text-muted"> · {info.venue}</span>}
        </p>
        {info.reviewsLoaded && info.reviews.length > 0 && (
          <div>
            <p className="text-muted">
              {info.reviews.length} review{info.reviews.length === 1 ? "" : "s"}
              {average !== null && (
                <>
                  {" "}
                  · ratings {scores.join(", ")} (avg {average.toFixed(1)})
                </>
              )}
            </p>
            <ul className="mt-1.5 space-y-1">
              {info.reviews.map((r, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === i ? null : i)}
                    aria-expanded={open === i}
                    className="flex w-full items-start gap-1.5 text-left hover:text-text"
                  >
                    <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
                    <span className={cn("text-muted", open === i && "text-text")}>
                      Reviewer {i + 1}
                      {r.rating ? ` — ${r.rating}` : ""}
                    </span>
                  </button>
                  {open === i && r.summary && (
                    <p className="mt-1 ml-5 text-[12.5px] whitespace-pre-line text-muted">{r.summary}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!info.reviewsLoaded && (
          <p className="text-[12.5px] text-subtle">
            Reviews open on OpenReview. (To show them here, an OpenReview account must be configured on the server.)
          </p>
        )}
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-accent-text hover:underline"
        >
          Open on OpenReview
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </section>
  );
}
