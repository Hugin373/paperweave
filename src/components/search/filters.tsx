"use client";

import { Field, Input, Select } from "@/components/ui/input";
import { PUBLICATION_TYPE_LABEL } from "@/lib/format";

export interface SearchFilterValues {
  yearFrom: string;
  yearTo: string;
  oa: boolean;
  minCitations: string;
  venue: string;
  type: string;
}

export const EMPTY_FILTERS: SearchFilterValues = {
  yearFrom: "",
  yearTo: "",
  oa: false,
  minCitations: "",
  venue: "",
  type: "",
};

/**
 * Offered while typing a venue. Short names work (the server knows their full names), as do journal names
 * and publishers ("Frontiers", "Springer Nature", "IEEE": all their journals).
 */
const VENUE_SUGGESTIONS = [
  "CVPR",
  "ICCV",
  "ECCV",
  "MICCAI",
  "NeurIPS",
  "ICML",
  "ICLR",
  "AAAI",
  "IJCAI",
  "ACL",
  "EMNLP",
  "NAACL",
  "KDD",
  "ICRA",
  "IROS",
  "CHI",
  "TPAMI",
  "IJCV",
  "Medical Image Analysis",
  "IEEE Transactions on Medical Imaging",
  "Nature",
  "Science",
  "Cell",
  "Nature Communications",
  "Scientific Reports",
  "PNAS",
  "The Lancet",
  "NEJM",
  "Frontiers",
  "Springer Nature",
  "IEEE",
  "Elsevier",
  "MDPI",
  "PLOS ONE",
];

export function countFilters(f: SearchFilterValues) {
  return [f.yearFrom, f.yearTo, f.oa ? "1" : "", f.minCitations, f.venue, f.type].filter(Boolean).length;
}

const TYPES = ["journal_article", "conference", "preprint", "review", "book"];

export function SearchFilters({
  value,
  onChange,
}: {
  value: SearchFilterValues;
  onChange: (v: SearchFilterValues) => void;
}) {
  const set = (patch: Partial<SearchFilterValues>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5">
      <div className="flex gap-2 lg:col-span-1">
        <Field label="From year" htmlFor="f-year-from" className="flex-1">
          <Input
            id="f-year-from"
            inputMode="numeric"
            placeholder="e.g. 2019"
            value={value.yearFrom}
            onChange={(e) => set({ yearFrom: e.target.value.replace(/\D/g, "").slice(0, 4) })}
          />
        </Field>
        <Field label="To" htmlFor="f-year-to" className="flex-1">
          <Input
            id="f-year-to"
            inputMode="numeric"
            placeholder="2026"
            value={value.yearTo}
            onChange={(e) => set({ yearTo: e.target.value.replace(/\D/g, "").slice(0, 4) })}
          />
        </Field>
      </div>
      <Field label="Minimum citations" htmlFor="f-cites">
        <Input
          id="f-cites"
          inputMode="numeric"
          placeholder="Any"
          value={value.minCitations}
          onChange={(e) => set({ minCitations: e.target.value.replace(/\D/g, "").slice(0, 7) })}
        />
      </Field>
      <Field label="Venue" htmlFor="f-venue">
        <Input
          id="f-venue"
          placeholder="e.g. MICCAI, ACL, Nature, Frontiers"
          list="f-venue-suggestions"
          value={value.venue}
          onChange={(e) => set({ venue: e.target.value })}
        />
        <datalist id="f-venue-suggestions">
          {VENUE_SUGGESTIONS.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </Field>
      <Field label="Publication type" htmlFor="f-type">
        <Select id="f-type" value={value.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="">Any type</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {PUBLICATION_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end pb-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={value.oa}
            onChange={(e) => set({ oa: e.target.checked })}
          />
          Open access only
        </label>
      </div>
    </div>
  );
}
