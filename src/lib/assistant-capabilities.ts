/**
 * What the assistant can do, in plain words, for the "What can the Assistant do?" panel. Each item names the
 * tools behind it; a test checks that every tool the assistant has is listed here, so this cannot go stale.
 */

import type { ResearchMode } from "./types";

export interface AssistantCapability {
  title: string;
  /** Shown next to the title, e.g. which toggle it needs. */
  note?: string;
  items: { text: string; tools: string[] }[];
  examples: { text: string; mode?: ResearchMode }[];
}

export const ASSISTANT_CAPABILITIES: AssistantCapability[] = [
  {
    title: "Find papers",
    note: "with Literature search or Deep research on",
    items: [
      {
        text: "Search all fields, biomedical sources or ML venues (OpenReview), by relevance, newest or most cited",
        tools: ["search_papers"],
      },
      { text: "Get the newest arXiv preprints, often days old", tools: ["search_arxiv"] },
      { text: "Follow a paper's references and the papers that cite it", tools: ["references", "citations"] },
    ],
    examples: [
      { text: "Find the most cited papers on 3D Gaussian splatting since 2023", mode: "search" },
      { text: "What are the newest preprints on world models for robotics?", mode: "search" },
    ],
  },
  {
    title: "Analyze a field",
    note: "with Field analysis on",
    items: [
      {
        text: "Map a field's trends with papers-per-year counts, its sub-areas, current gaps and possible research directions",
        tools: ["publication_trend"],
      },
    ],
    examples: [
      { text: "Analyze the field of spatial AI: trends, current gaps and possible research directions", mode: "field" },
    ],
  },
  {
    title: "Read and understand papers",
    items: [
      { text: "Read a paper's full text, or the pages you name", tools: ["read_paper"] },
      { text: "Find passages by meaning across your papers", tools: ["find_passages"] },
      { text: "Look at figures, tables and equations as images", tools: ["view_page"] },
      { text: "Compare papers field by field in a table, with page references", tools: ["extract_fields"] },
      { text: "Show what changed between arXiv versions", tools: ["compare_versions"] },
      { text: "Read OpenReview decisions and reviews", tools: ["read_reviews"] },
      {
        text: "Find a paper's code, datasets and models, and read repositories and model cards",
        tools: ["find_resources", "read_resource"],
      },
      { text: "Do exact calculations, e.g. memory or compute estimates", tools: ["calculate"] },
    ],
    examples: [
      { text: "Explain Figure 3 of this paper" },
      { text: "Compare the datasets, metrics and results of my depth estimation papers in a table" },
    ],
  },
  {
    title: "Use your library and notes",
    items: [
      {
        text: "Search and list your papers, notes, highlights, collections, tags and concepts",
        tools: [
          "search_library",
          "list_workspace",
          "find_saved_papers",
          "paper_info",
          "related_in_library",
          "read_highlights",
          "read_note",
          "list_concepts",
          "read_concept",
        ],
      },
    ],
    examples: [
      { text: "What did I highlight in my MRI papers, and what do my notes say about them?" },
      { text: "Which of my unread papers should I read next for my thesis?" },
    ],
  },
  {
    title: "Organize",
    items: [
      {
        text: "Save papers, then (if you want) put them in the collections and concepts they fit; set reading statuses",
        tools: ["save_papers", "suggest_placement", "set_reading_status"],
      },
      {
        text: "Create, rename and describe collections; add papers or take them out",
        tools: ["create_collection", "add_to_collection", "remove_from_collection", "edit_collection"],
      },
      { text: "Tag and untag papers; rename tags", tools: ["tag_papers", "untag_papers", "rename_tag"] },
      {
        text: "Create, link, merge, rename and describe concepts",
        tools: [
          "create_concept",
          "link_concept",
          "unlink_concept",
          "relate_concepts",
          "merge_concepts",
          "rename_concept",
          "edit_concept",
        ],
      },
      { text: "Attach the papers' free PDFs", tools: ["attach_pdfs"] },
    ],
    examples: [
      { text: "Organize my library into collections by topic, judging each paper by its abstract" },
      { text: "Clean up my tags and concepts: merge duplicates and fix vague names" },
    ],
  },
  {
    title: "Write notes and highlight",
    items: [
      {
        text: "Write notes, add to or edit your notes, attach them to papers",
        tools: ["create_note", "append_to_note", "edit_note", "link_note"],
      },
      { text: "Highlight passages in a PDF, with a comment", tools: ["add_highlight"] },
    ],
    examples: [{ text: "Summarize this paper's method into a note on it, and highlight the key claims" }],
  },
  {
    title: "Keep up with new papers",
    items: [
      { text: "Follow a topic: checked daily, new papers listed under New papers", tools: ["save_search"] },
      { text: "Go through what's new and rank it against your library", tools: ["read_new_papers"] },
      { text: "Stop following a topic", tools: ["stop_following"] },
    ],
    examples: [
      { text: "Set up New papers searches for the main topics in my library" },
      { text: "What's new this week that matters for my work?" },
    ],
  },
  {
    title: "Screen papers",
    items: [
      {
        text: "Screen up to 500 papers against inclusion and exclusion criteria, and report the results",
        tools: ["start_screening", "read_screening"],
      },
    ],
    examples: [
      { text: "Screen my Alzheimer's collection: include only longitudinal MRI studies with over 100 subjects" },
    ],
  },
  {
    title: "Delete",
    note: "only when you ask; never applied automatically",
    items: [
      {
        text: "Delete collections, tags or concepts; remove papers from the library (notes and highlights are kept)",
        tools: ["delete_collection", "delete_tag", "delete_concept", "remove_from_library"],
      },
    ],
    examples: [{ text: "Delete the tags I no longer use" }],
  },
];

/** Things only you can do, and where. The assistant says so when asked. */
export const ASSISTANT_CANNOT: { what: string; where: string }[] = [
  { what: "Delete notes or highlights", where: "a note's menu → Delete; click a highlight in the reader" },
  { what: "Upload a PDF file", where: "the paper's page → Upload PDF" },
  { what: "Import BibTeX or DOIs, or export", where: "Settings → Import / Export" },
  { what: "Share collections, notes or concepts", where: "the Share button on them" },
  { what: "Change AI or account settings", where: "Settings" },
  { what: "Edit a paper's title, authors or details", where: "read-only; Refresh on the paper's page" },
];

/** Tools the assistant uses for itself, not abilities to list. */
export const INTERNAL_ASSISTANT_TOOLS = ["open_playbook"];
