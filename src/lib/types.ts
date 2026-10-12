/** API data contracts shared by server route handlers and client components. */

export const READING_STATUSES = ["saved", "reading", "read", "archived"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export type IdentifierMap = Partial<
  Record<"doi" | "arxiv" | "s2" | "openalex" | "pmid" | "pmcid" | "corpus" | "openreview", string>
>;

export interface LibraryState {
  status: ReadingStatus;
  addedAt: string;
}

export interface PaperSummary {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  citationCount: number | null;
  referenceCount: number | null;
  isOpenAccess: boolean | null;
  openAccessPdfUrl: string | null;
  publicationTypes: string[];
  ids: IdentifierMap;
  library: LibraryState | null;
  /** True for papers entered manually by the user (not from a scholarly source). */
  isUserPaper: boolean;
  /**
   * A free, legal PDF is known to exist: an open-access link from the scholarly sources (or found by
   * the Unpaywall check), the arXiv copy, or OpenReview when Paperweave is signed in there.
   */
  pdfAvailable: boolean;
  /** A page where the paper is free to read when no downloadable PDF is known (e.g. PubMed Central). */
  freeReadUrl: string | null;
}

export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}

export interface CollectionRef {
  id: string;
  name: string;
  color: string | null;
}

export interface ConceptRef {
  id: string;
  name: string;
}

export interface NoteRef {
  id: string;
  title: string;
}

export interface PaperFileInfo {
  id: string;
  filename: string;
  source: "upload" | "open_access" | "external_url";
  sourceUrl: string | null;
  sizeBytes: number;
  pageCount: number | null;
  textStatus: "pending" | "processing" | "ready" | "failed";
  createdAt: string;
  /** Read from its source each time instead of stored here (always the source's current version). */
  live: boolean;
  /** The source's version of the PDF (arXiv: "v3"), when it numbers versions. */
  version: string | null;
  /** Where the reader loads the PDF: the source itself when it allows that (arXiv), else this app. */
  viewUrl: string;
  /** arXiv id when the PDF comes from arXiv (older versions can be opened there). */
  arxivId: string | null;
  /** Set when the PDF was replaced by a newer version since the reader last showed it. */
  versionNotice: VersionNotice | null;
  /** The PDF can switch between live and stored (it has a free source). */
  canSwitch: boolean;
}

export interface VersionNotice {
  from: string | null;
  to: string | null;
  /** Highlights placed in the new version. */
  moved: number;
  /** Highlights whose text was not found in the new version. */
  lost: number;
  at: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  paperId: string | null;
  paperTitle: string | null;
  updatedAt: string;
}

export interface PaperDetail extends PaperSummary {
  publicationDate: string | null;
  fieldsOfStudy: string[];
  url: string | null;
  influentialCitationCount: number | null;
  authorDetails: { name: string; ids?: Record<string, string> }[];
  metadataSource: string;
  metadataRefreshedAt: string | null;
  tags: TagRef[];
  collections: CollectionRef[];
  concepts: ConceptRef[];
  files: PaperFileInfo[];
  notes: NoteSummary[];
  /** Notes (other than this paper's own notes) that link to this paper. */
  mentionedIn: NoteSummary[];
  highlightCount: number;
}

/** A paper's record on OpenReview (ML venues). */
export interface OpenReviewInfoDto {
  forumId: string;
  url: string;
  venue: string | null;
  decision: string | null;
  reviews: { rating: string | null; confidence: string | null; summary: string | null }[];
  /** False when reviews could not be loaded because no OpenReview account is configured. */
  reviewsLoaded: boolean;
}

export interface LibraryItem extends PaperSummary {
  library: LibraryState;
  tags: TagRef[];
  collections: CollectionRef[];
  hasPdf: boolean;
  noteCount: number;
  updatedAt: string;
}

export interface LibraryResponse {
  items: LibraryItem[];
  total: number;
  counts: Record<ReadingStatus | "all", number>;
}

export interface SearchResponse {
  items: PaperSummary[];
  total: number | null;
  offset: number;
  limit: number;
  provider: string;
  /** The query actually sent to scholarly sources, when it differs from the input. */
  interpretedQuery?: string;
  identifier?: { kind: string; value: string };
  /** With "newest first": the most recently posted matching arXiv preprints (often not indexed yet). */
  latestPreprints?: PaperSummary[];
}

export interface CitationListItem {
  paper: PaperSummary | null;
  rawTitle: string | null;
  isInfluential: boolean | null;
  intents: string[];
  contexts: string[];
}

export interface CitationListResponse {
  items: CitationListItem[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number;
  provider: string | null;
}

export interface CollectionSummary extends CollectionRef {
  description: string;
  paperCount: number;
  updatedAt: string;
}

export interface TagSummary extends TagRef {
  paperCount: number;
}

export interface NoteLinks {
  papers: { id: string; title: string }[];
  concepts: ConceptRef[];
  notes: NoteRef[];
}

export type AccessLevel = "owner" | "edit" | "view";

export interface NoteDetail {
  id: string;
  title: string;
  content: unknown;
  paper: { id: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
  links: NoteLinks;
  backlinks: NoteSummary[];
  access: AccessLevel;
  ownerName: string | null;
}

export interface ConceptSummary {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  origin: "user" | "ai_suggestion";
  paperCount: number;
  noteCount: number;
  updatedAt: string;
}

export interface ConceptDetail extends ConceptSummary {
  papers: PaperSummary[];
  notes: NoteSummary[];
  related: ConceptRef[];
  access: AccessLevel;
}

export type GraphNodeType = "paper" | "concept" | "note";
export type GraphEdgeType =
  "cites" | "paper_concept" | "note_about_paper" | "note_paper" | "note_concept" | "note_note" | "concept_concept";

export interface GraphNode {
  /** Graph-unique id, e.g. "paper:<uuid>". */
  id: string;
  type: GraphNodeType;
  entityId: string;
  label: string;
  sublabel?: string;
  status?: ReadingStatus | null;
  citationCount?: number | null;
  year?: number | null;
  /** For citation graphs: position relative to the focus paper. */
  role?: "center" | "reference" | "citation" | "expanded";
  /** Papers: the workspace collections they belong to (knowledge graph). */
  collectionIds?: string[];
  /** Display override set by the view (e.g. "color by collection"): a fill color, or "dim". */
  color?: string;
  /** Display override: a second color shown as a ring (2D). */
  ring?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  /** Collections of the papers shown (knowledge graph), for coloring and the legend. */
  collections?: { id: string; name: string; color: string | null }[];
}

export interface CitationGraphResponse extends GraphResponse {
  papers: Record<string, PaperSummary>;
  partial: boolean;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightDto {
  id: string;
  fileId: string;
  paperId: string;
  kind: "highlight" | "note";
  pageNumber: number;
  rects: HighlightRect[];
  selectedText: string;
  prefix: string;
  suffix: string;
  color: string;
  comment: string;
  /** The highlighted text was not found in a newer version of the PDF. */
  lost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSearchResponse {
  query: string;
  papers: { paper: PaperSummary; snippet: string | null }[];
  notes: (NoteSummary & { snippet: string | null })[];
  concepts: (ConceptRef & { snippet: string | null })[];
  highlights: { id: string; paperId: string; paperTitle: string; pageNumber: number; text: string; comment: string }[];
  pdfPages: { paperId: string; paperTitle: string; fileId: string; pageNumber: number; snippet: string }[];
  tags: TagSummary[];
  collections: CollectionSummary[];
}

export type AiProviderKind = "openai" | "anthropic" | "openai_compatible" | "ollama" | "claude_code" | "codex" | "mock";

/** A provider/model/effort picked while working, overriding the workspace default for a request. */
export interface AiChoice {
  provider: AiProviderKind;
  model: string;
  effort: AiEffort | null;
}

/** How long the model thinks before answering. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export interface AiEffortOption {
  value: AiEffort;
  description?: string;
}

/** A model offered in the settings dropdown. */
export interface AiModelOption {
  value: string;
  label: string;
  description?: string;
  /** Effort levels this model supports (when known), and its default. */
  efforts?: AiEffortOption[];
  defaultEffort?: AiEffort;
}

/** What a workspace remembers for one provider, so switching providers does not lose settings. */
export interface AiProviderSettingsDto {
  model: string;
  effort: AiEffort | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
}

export interface AiConfigDto {
  configured: boolean;
  enabled: boolean;
  provider: AiProviderKind | null;
  model: string | null;
  effort: AiEffort | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  mockAvailable: boolean;
  /** Whether this server allows the Claude Code / Codex subscription providers. */
  subscriptionAvailable: boolean;
  /** Providers with saved settings that can be used right now (the model picker lists these). */
  connected: AiProviderKind[];
  saved: Partial<Record<AiProviderKind, AiProviderSettingsDto>>;
  /** Models known to be available, e.g. the models of the signed-in Codex account. */
  modelOptions: Partial<Record<AiProviderKind, AiModelOption[]>>;
}

/** What an AI answer about a paper was based on, shown next to it. */
export interface AiBasis {
  /** "pdf": the PDF in the workspace; "open_access": the free copy, read without saving; "pmc": PubMed Central. */
  source: "pdf" | "open_access" | "pmc" | "abstract";
  unit: "page" | "section";
  /** Pages (or sections) in the paper. */
  total: number;
  /** The pages (or sections) included, 1-based. */
  included: number[];
  /** "whole": read through for a paper-level task; "relevant": the parts matching a question. */
  selection: "whole" | "relevant";
  /** Reference-list pages left out. */
  skippedReferences: number;
  /** Some pages were shortened so the paper fit the model's context. */
  condensed: boolean;
}

export interface AiResultDto {
  id: string;
  kind: string;
  content: string;
  provider: string;
  model: string;
  basis: AiBasis | null;
  createdAt: string;
}

export interface ShareDto {
  id: string;
  resourceType: "collection" | "note" | "concept";
  resourceId: string;
  permission: "view" | "edit";
  grantee: { id: string; name: string; email: string } | null;
  linkUrl: string | null;
  createdAt: string;
}

export interface SharedWithMeItem {
  shareId: string;
  resourceType: "collection" | "note" | "concept";
  resourceId: string;
  title: string;
  permission: "view" | "edit";
  ownerName: string;
  createdAt: string;
}

export interface JobDto {
  id: number;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface MeResponse {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; role: string };
  onboardingDismissed: boolean;
  stats: { papers: number; notes: number; concepts: number; highlights: number };
  ai: { configured: boolean; enabled: boolean };
  /** Signed in automatically (SINGLE_USER_EMAIL): no password or sign-out. */
  singleUser: boolean;
}

// ---------------------------------------------------------------------------
// AI research assistant
// ---------------------------------------------------------------------------

/**
 * How the assistant works on a message. "chat": uses the workspace (library, notes, highlights, concepts,
 * known papers). "search": also searches the scholarly literature and follows citations. "deep": several
 * rounds of searching and reading, ending in a cited report. "field": a longer analysis of a whole field —
 * publication trends, landscape, gaps and research directions.
 */
export const RESEARCH_MODES = ["chat", "search", "deep", "field"] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];
export type ResearchStatus = "running" | "done" | "error" | "cancelled";

export type ResearchStepKind =
  | "plan"
  | "workspace"
  | "change"
  | "search"
  | "references"
  | "citations"
  | "read"
  | "library"
  | "note"
  | "write"
  | "rank"
  | "playbook"
  | "trend";

/** One visible step of the research process. */
export interface ResearchStep {
  id: string;
  kind: ResearchStepKind;
  label: string;
  /** Extra text, e.g. the agent's reasoning for a planning step. */
  detail?: string;
  /** Number of results found, when applicable. */
  count?: number;
  status: "running" | "done" | "error";
  at: string;
}

/** Something the research consulted; `key` (P3, N1) is how the answer cites it. */
export interface ResearchSource {
  key: string;
  type: "paper" | "note";
  id: string;
  title: string;
  year?: number | null;
  venue?: string | null;
  authors?: string;
  citationCount?: number | null;
}

export interface ResearchScope {
  paperIds: string[];
  collectionId: string | null;
}

export const CHANGE_KINDS = [
  "save_papers",
  "create_collection",
  "add_to_collection",
  "tag_papers",
  "create_concept",
  "link_concept",
  "create_note",
  "attach_pdfs",
  "set_status",
  "remove_from_collection",
  "unlink_concept",
  "relate_concepts",
  "append_to_note",
  "link_note",
  "merge_concepts",
  "rename_concept",
  "edit_note",
  "add_highlight",
  "save_search",
  "start_screening",
  "edit_collection",
  "delete_collection",
  "untag_papers",
  "rename_tag",
  "delete_tag",
  "edit_concept",
  "delete_concept",
  "remove_from_library",
  "stop_following",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Changes that delete something: never applied automatically (Auto-apply leaves their set for approval). */
export const DESTRUCTIVE_CHANGE_KINDS: readonly ChangeKind[] = [
  "delete_collection",
  "delete_tag",
  "delete_concept",
  "remove_from_library",
  "stop_following",
];

/** A change to the user's workspace proposed by the assistant (applied only on approval or auto-apply). */
export interface ProposedChange {
  id: string;
  kind: ChangeKind;
  /** Human-readable summary, e.g. 'Create collection "Depth" with 5 papers'. */
  label: string;
  paperIds: string[];
  /** Collection, concept or note name (editable before applying). */
  name?: string;
  /** Tag names (tag_papers). */
  tags?: string[];
  /** Broader concepts this concept is related to once applied (create_concept / link_concept). */
  related?: string[];
  /** For concepts: how useful the AI thinks it is for connecting the library, and why. */
  priority?: SourcePriority;
  why?: string;
  description?: string;
  /** Note content as a document (create_note), or the text to add (append_to_note). */
  doc?: unknown;
  /** The existing note a change adds to (append_to_note) or links (link_note). */
  noteId?: string;
  /** The paper link_note attaches the note to (it is then listed with that paper's notes). */
  attachPaperId?: string;
  /** Concepts merged into `name` (merge_concepts), or the old name (rename_concept). */
  fromNames?: string[];
  /** Block edits of an existing note (edit_note), shown before / after for review. */
  edits?: NoteBlockEdit[];
  /** The note's last change when the edit was proposed: applying fails if it changed since. */
  noteUpdatedAt?: string;
  /** add_highlight: where the quoted passage was found in the paper's PDF. */
  highlight?: {
    fileId: string;
    pageNumber: number;
    rects: HighlightRect[];
    selectedText: string;
    prefix: string;
    suffix: string;
    color: string;
    comment: string;
  };
  status: "proposed" | "applied" | "failed" | "skipped" | "undone";
  error?: string;
  /** What applying changed — used for links and undo. */
  result?: {
    collectionId?: string;
    conceptId?: string;
    noteId?: string;
    created?: boolean;
    /** Papers newly added (to the library, collection, concept, tag). */
    addedPaperIds?: string[];
    /** Papers this change saved to the library (removed again on undo). */
    savedPaperIds?: string[];
    createdTagIds?: string[];
    addedTagPairs?: [string, string][];
    fileIds?: string[];
    failedPaperIds?: string[];
    /** Concept relations this change made ([concept, related concept]), removed on undo. */
    relatedPairs?: [string, string][];
    /** Papers taken out of a collection or unlinked from a concept (restored on undo). */
    removedPaperIds?: string[];
    /** Reading statuses before set_status, by paper (restored on undo). */
    previousStatuses?: Record<string, ReadingStatus>;
    /** The note's content before append_to_note, and when the change saved it (undo only if unchanged since). */
    previousDoc?: unknown;
    savedAt?: string;
    /** The paper the note was attached to before link_note (restored on undo). */
    previousPaperId?: string | null;
    /** rename_concept: the name and aliases before (restored on undo). */
    previousName?: string;
    previousAliases?: string[];
    /** merge_concepts: everything needed to bring the merged concepts back on undo. */
    merged?: unknown;
    highlightId?: string;
    /** save_search: the saved search, and whether this change created it (undo deletes only then). */
    savedSearchId?: string;
    screeningId?: string;
    /** edit_collection / rename_tag / edit_concept: the name and description before (restored on undo). */
    previousDescription?: string;
    tagId?: string;
    /** untag_papers: the [paper, tag] pairs removed (restored on undo). */
    removedTagPairs?: [string, string][];
    /** delete_* / remove_from_library / stop_following: the deleted rows, put back with their ids on undo. */
    deleted?: unknown;
  };
}

/** One edit of a note's top-level blocks (numbered from 1 as the assistant read them). */
export interface NoteBlockEdit {
  op: "replace" | "delete" | "insert";
  /** The block replaced or deleted, or the block an insert goes after (0 = at the start). */
  block: number;
  /** The block's text before the edit (replace / delete). */
  before?: string;
  /** The new text (replace / insert). */
  after?: string;
}

export interface ChangeSet {
  status: "proposed" | "applied" | "dismissed" | "undone";
  autoApplied: boolean;
  items: ProposedChange[];
}

export const SOURCE_PRIORITIES = ["high", "medium", "low"] as const;
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];

/** The AI's ranking of the papers a reply cites: a reading order, then a priority for the rest. */
export interface SourceRanking {
  /** Papers to read first, in order. */
  start: { key: string; why: string | null }[];
  /** Every other cited source: how much it matters for the question. */
  priority: { key: string; level: SourcePriority; why: string | null }[];
  provider?: AiProviderKind | null;
  model?: string | null;
}

/** What the user is looking at when they ask from the PDF reader. */
export interface ReaderContext {
  paperId: string;
  /** The page on screen. */
  page?: number | null;
  /** Text the user selected, if any. */
  selection?: string | null;
}

export const RESEARCH_ORIGINS = ["assistant", "reader"] as const;
export type ResearchOrigin = (typeof RESEARCH_ORIGINS)[number];

export interface ResearchMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: ResearchMode;
  status: ResearchStatus;
  error: string | null;
  steps: ResearchStep[];
  sources: ResearchSource[];
  changes: ChangeSet | null;
  /** The AI's ranking of the cited sources (null: not ranked; the list falls back to citation counts). */
  ranking: SourceRanking | null;
  /** For questions asked from the reader: the page and selection they were about. */
  context: ReaderContext | null;
  provider: AiProviderKind | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchThreadSummary {
  id: string;
  title: string;
  origin: ResearchOrigin;
  status: ResearchStatus;
  updatedAt: string;
}

export interface ResearchThreadDto {
  id: string;
  title: string;
  /** Where the conversation was started: the Assistant page, or the PDF reader's AI tab. */
  origin: ResearchOrigin;
  scope: ResearchScope;
  /** Papers in the scope, for display. */
  scopePapers: PaperSummary[];
  scopeCollection: { id: string; name: string } | null;
  messages: ResearchMessageDto[];
  /** Summaries of every paper cited or consulted, keyed by paper id (for save controls). */
  papers: Record<string, PaperSummary>;
  createdAt: string;
  updatedAt: string;
}

export type AlertSource = "general" | "biomedical" | "openreview" | "arxiv";

/** A saved search that runs daily, with how many of its papers are new. */
/** A suggested literature search on the search page. */
export interface TopicSuggestion {
  query: string;
  why: string;
  /**
   * library: the user's concepts and collections; builds_on: papers their library often cites; cited_by: recent
   * papers citing theirs; neighbouring: other fields connected to theirs; related: ideas for their research.
   */
  kind: "library" | "builds_on" | "cited_by" | "neighbouring" | "related";
  /** neighbouring: the other field, in a few words. */
  field?: string;
  /** Thought up by the AI (the others come from the library and its citations). */
  ai?: boolean;
}

/** Papers published per year for one or more topics (OpenAlex, titles and abstracts). */
export interface PublicationTrend {
  years: number[];
  series: {
    query: string;
    counts: number[];
    /** Last three full years against the three before (0.5 = +50%); null without enough papers. */
    growth: number | null;
    /** The same, for the topic's share of all papers (growth beyond the literature's own). */
    shareGrowth: number | null;
  }[];
  /** All papers per year, for comparison. */
  all: number[];
  /** The current year, when it is included and so not yet complete. */
  partialYear: number | null;
}

export interface TopicSuggestionsResponse {
  library: TopicSuggestion[];
  ai: {
    /** off: no AI set up; pending: being thought up in the background (older ideas may be shown meanwhile). */
    status: "off" | "pending" | "ready" | "error";
    items: TopicSuggestion[];
    generatedAt: string | null;
  };
}

export interface SavedSearchDto {
  id: string;
  query: string;
  source: AlertSource;
  newCount: number;
  total: number;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface SavedSearchResults {
  search: SavedSearchDto;
  papers: (PaperSummary & { isNew: boolean; foundAt: string })[];
}

export type ScreeningDecision = "pending" | "include" | "exclude" | "maybe";

export interface ScreeningSummary {
  id: string;
  title: string;
  criteria: string;
  useFullText: boolean;
  status: "running" | "paused" | "done";
  counts: Record<ScreeningDecision, number>;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScreeningItemDto {
  paper: PaperSummary;
  decision: ScreeningDecision;
  reason: string;
  /** The passage the decision rests on. */
  evidence: string;
  decidedBy: "ai" | "user" | null;
  error: string | null;
  updatedAt: string;
}

export interface ScreeningDetail extends ScreeningSummary {
  items: ScreeningItemDto[];
}
