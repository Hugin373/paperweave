/**
 * Database schema.
 *
 * Three kinds of data are kept deliberately separate:
 *  1. Scholarly metadata from external sources (papers, identifiers, citations) — global,
 *     shared by every workspace and never edited by users or AI.
 *  2. User-created knowledge (library state, notes, concepts, highlights…) — always
 *     scoped to a workspace.
 *  3. AI output (ai_results) — stored separately and always labeled as AI-generated.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AiBasis,
  AiEffort,
  ChangeSet,
  LocalModelSettings,
  ResearchMode,
  ResearchScope,
  ResearchSource,
  ResearchStatus,
  ReaderContext,
  ResearchOrigin,
  ResearchStep,
  SourceRanking,
  VersionNotice,
} from "@/lib/types";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Authentication (managed by Better Auth; column names follow its conventions)
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  onboardingDismissedAt: timestamp("onboarding_dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const workspaceRole = pgEnum("workspace_role", ["owner", "editor", "viewer"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isPersonal: boolean("is_personal").notNull().default(true),
  ...timestamps,
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("workspace_members_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Scholarly metadata (global)
// ---------------------------------------------------------------------------

export type PaperAuthor = {
  name: string;
  /** External author ids, e.g. { s2: "1741101", openalex: "A5023888391", orcid: "..." } */
  ids?: Record<string, string>;
};

export const paperSource = pgEnum("paper_source", [
  "semantic_scholar",
  "openalex",
  "crossref",
  "arxiv",
  "user",
  "europepmc",
  "openreview",
]);

export const papers = pgTable(
  "papers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for scholarly records. Set for papers a user entered manually (private to that workspace). */
    ownerWorkspaceId: uuid("owner_workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    source: paperSource("source").notNull(),
    title: text("title").notNull(),
    abstract: text("abstract"),
    year: integer("year"),
    publicationDate: date("publication_date"),
    venue: text("venue"),
    publicationTypes: text("publication_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fieldsOfStudy: text("fields_of_study")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authors: jsonb("authors")
      .$type<PaperAuthor[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    authorsText: text("authors_text").notNull().default(""),
    citationCount: integer("citation_count"),
    referenceCount: integer("reference_count"),
    influentialCitationCount: integer("influential_citation_count"),
    isOpenAccess: boolean("is_open_access"),
    openAccessPdfUrl: text("open_access_pdf_url"),
    url: text("url"),
    /** Normalized title used for conservative duplicate detection. */
    titleNorm: text("title_norm").notNull(),
    firstAuthorNorm: text("first_author_norm"),
    /** Last time metadata was refreshed/enriched from external sources. */
    metadataRefreshedAt: timestamp("metadata_refreshed_at", { withTimezone: true }),
    /** Last time Unpaywall was asked for a free PDF of this paper (see papers/open-access.ts). */
    oaCheckedAt: timestamp("oa_checked_at", { withTimezone: true }),
    /** When the arXiv version of a paper known only from elsewhere (OpenReview) was last looked for. */
    arxivCheckedAt: timestamp("arxiv_checked_at", { withTimezone: true }),
    /** A page where the paper is free to read when no downloadable PDF is known (e.g. PubMed Central). */
    freeReadUrl: text("free_read_url"),
    referencesSyncedAt: timestamp("references_synced_at", { withTimezone: true }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(authors_text, '')), 'B') || setweight(to_tsvector('english', coalesce(abstract, '')), 'C')`,
    ),
    ...timestamps,
  },
  (t) => [
    index("papers_title_norm_idx").on(t.titleNorm),
    index("papers_search_idx").using("gin", t.searchVector),
    index("papers_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
    index("papers_owner_idx").on(t.ownerWorkspaceId),
  ],
);

export const identifierKind = pgEnum("identifier_kind", [
  "doi",
  "arxiv",
  "s2",
  "openalex",
  "pmid",
  "pmcid",
  "corpus",
  "openreview",
]);

export const paperIdentifiers = pgTable(
  "paper_identifiers",
  {
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    kind: identifierKind("kind").notNull(),
    value: text("value").notNull(),
    /** Identifiers of user-entered papers are only unique within that workspace. */
    scope: text("scope").notNull().default("global"),
  },
  (t) => [primaryKey({ columns: [t.scope, t.kind, t.value] }), index("paper_identifiers_paper_idx").on(t.paperId)],
);

export const citations = pgTable(
  "citations",
  {
    citingPaperId: uuid("citing_paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    citedPaperId: uuid("cited_paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    isInfluential: boolean("is_influential"),
    intents: text("intents")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contexts: text("contexts")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: paperSource("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.citingPaperId, t.citedPaperId] }),
    index("citations_cited_idx").on(t.citedPaperId),
    check("citations_no_self", sql`${t.citingPaperId} <> ${t.citedPaperId}`),
  ],
);

/** Cache of raw responses from external scholarly APIs. */
export const externalCache = pgTable(
  "external_cache",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("external_cache_expires_idx").on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Library & organization (workspace-scoped)
// ---------------------------------------------------------------------------

export const readingStatus = pgEnum("reading_status", ["saved", "reading", "read", "archived"]);

export const libraryItems = pgTable(
  "library_items",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    status: readingStatus("status").notNull().default("saved"),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.paperId] }),
    index("library_items_ws_status_idx").on(t.workspaceId, t.status),
    index("library_items_paper_idx").on(t.paperId),
  ],
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color"),
    ...timestamps,
  },
  (t) => [uniqueIndex("collections_ws_name_uq").on(t.workspaceId, sql`lower(${t.name})`)],
);

export const collectionPapers = pgTable(
  "collection_papers",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.paperId] }), index("collection_papers_paper_idx").on(t.paperId)],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_ws_name_uq").on(t.workspaceId, sql`lower(${t.name})`)],
);

export const paperTags = pgTable(
  "paper_tags",
  {
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tagId, t.paperId] }), index("paper_tags_paper_idx").on(t.paperId)],
);

// ---------------------------------------------------------------------------
// Knowledge: notes, concepts, links
// ---------------------------------------------------------------------------

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Set for paper notes; null for standalone notes. */
    paperId: uuid("paper_id").references(() => papers.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    /** ProseMirror/TipTap document JSON. */
    content: jsonb("content")
      .notNull()
      .default(sql`'{"type":"doc","content":[]}'::jsonb`),
    /** Plain-text projection of `content`, used for search and previews. */
    contentText: text("content_text").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')`,
    ),
    ...timestamps,
  },
  (t) => [
    index("notes_ws_updated_idx").on(t.workspaceId, t.updatedAt),
    index("notes_paper_idx").on(t.paperId),
    index("notes_search_idx").using("gin", t.searchVector),
  ],
);

export const conceptOrigin = pgEnum("concept_origin", ["user", "ai_suggestion"]);

export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text("description").notNull().default(""),
    /** Records whether the concept was created by accepting an AI suggestion. */
    origin: conceptOrigin("origin").notNull().default("user"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', pw_array_to_text(aliases)), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("concepts_ws_name_uq").on(t.workspaceId, sql`lower(${t.name})`),
    index("concepts_search_idx").using("gin", t.searchVector),
  ],
);

/** User-asserted link between a paper and a concept. */
export const paperConcepts = pgTable(
  "paper_concepts",
  {
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conceptId, t.paperId] }), index("paper_concepts_paper_idx").on(t.paperId)],
);

/** Undirected concept ↔ concept relation, stored once with concept_a_id < concept_b_id. */
export const conceptRelations = pgTable(
  "concept_relations",
  {
    conceptAId: uuid("concept_a_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    conceptBId: uuid("concept_b_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conceptAId, t.conceptBId] }),
    index("concept_relations_b_idx").on(t.conceptBId),
    check("concept_relations_ordered", sql`${t.conceptAId} < ${t.conceptBId}`),
  ],
);

/**
 * Links from a note to a paper, concept or another note. Derived from the mentions in the
 * note's content every time the note is saved, so the content is the source of truth.
 */
export const noteLinks = pgTable(
  "note_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    targetPaperId: uuid("target_paper_id").references(() => papers.id, { onDelete: "cascade" }),
    targetConceptId: uuid("target_concept_id").references(() => concepts.id, { onDelete: "cascade" }),
    targetNoteId: uuid("target_note_id").references(() => notes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("note_links_one_target", sql`num_nonnulls(${t.targetPaperId}, ${t.targetConceptId}, ${t.targetNoteId}) = 1`),
    uniqueIndex("note_links_paper_uq")
      .on(t.noteId, t.targetPaperId)
      .where(sql`${t.targetPaperId} is not null`),
    uniqueIndex("note_links_concept_uq")
      .on(t.noteId, t.targetConceptId)
      .where(sql`${t.targetConceptId} is not null`),
    uniqueIndex("note_links_note_uq")
      .on(t.noteId, t.targetNoteId)
      .where(sql`${t.targetNoteId} is not null`),
    index("note_links_target_paper_idx").on(t.targetPaperId),
    index("note_links_target_concept_idx").on(t.targetConceptId),
    index("note_links_target_note_idx").on(t.targetNoteId),
  ],
);

// ---------------------------------------------------------------------------
// PDFs, highlights, annotations
// ---------------------------------------------------------------------------

export const fileSource = pgEnum("file_source", ["upload", "open_access", "external_url"]);
export const textStatus = pgEnum("text_status", ["pending", "processing", "ready", "failed"]);

export const paperFiles = pgTable(
  "paper_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    /** Where the PDF is stored; null for a live PDF, read from `sourceUrl` each time and never stored. */
    storageKey: text("storage_key").unique(),
    source: fileSource("source").notNull(),
    sourceUrl: text("source_url"),
    /** The source's version of this PDF (arXiv: "v3"), when the source numbers its versions. */
    version: text("version"),
    /** When the source was last checked for a newer version. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** Set when the PDF was replaced by a newer version, until the reader has shown it. */
    versionNotice: jsonb("version_notice").$type<VersionNotice>(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    pageCount: integer("page_count"),
    textStatus: textStatus("text_status").notNull().default("pending"),
    textError: text("text_error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("paper_files_ws_paper_sha_uq").on(t.workspaceId, t.paperId, t.sha256),
    index("paper_files_ws_paper_idx").on(t.workspaceId, t.paperId),
  ],
);

/**
 * Embeddings for meaning-based search: chunks of PDF pages, paper abstracts and notes, as vectors from
 * the local embedding model. Rebuilt when the text changes (content_hash) or the model changes.
 */
export const textEmbeddings = pgTable(
  "text_embeddings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<"pdf" | "abstract" | "note">().notNull(),
    fileId: uuid("file_id").references(() => paperFiles.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id").references(() => papers.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    page: integer("page"),
    chunk: integer("chunk").notNull().default(0),
    text: text("text").notNull(),
    vector: real("vector").array().notNull(),
    model: text("model").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("text_embeddings_ws_idx").on(t.workspaceId),
    index("text_embeddings_file_idx").on(t.fileId),
    index("text_embeddings_note_idx").on(t.noteId),
    index("text_embeddings_paper_idx").on(t.paperId, t.sourceKind),
  ],
);

/** Extracted text per PDF page — used for workspace search and AI retrieval. */
export const paperFilePages = pgTable(
  "paper_file_pages",
  {
    fileId: uuid("file_id")
      .notNull()
      .references(() => paperFiles.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    text: text("text").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector('english', coalesce(text, ''))`),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.pageNumber] }),
    index("paper_file_pages_search_idx").using("gin", t.searchVector),
  ],
);

export type HighlightRect = { x: number; y: number; width: number; height: number };

export const highlightKind = pgEnum("highlight_kind", ["highlight", "note"]);

/**
 * Highlights (text selections) and page notes in a PDF.
 * Positions are stored as rectangles normalized to the page size (0..1), so they are
 * independent of zoom level. The selected text plus prefix/suffix act as a text-quote
 * anchor (W3C Web Annotation style) so a highlight can be re-identified if needed.
 */
export const highlights = pgTable(
  "highlights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => paperFiles.id, { onDelete: "cascade" }),
    kind: highlightKind("kind").notNull().default("highlight"),
    pageNumber: integer("page_number").notNull(),
    rects: jsonb("rects").$type<HighlightRect[]>().notNull(),
    selectedText: text("selected_text").notNull().default(""),
    prefix: text("prefix").notNull().default(""),
    suffix: text("suffix").notNull().default(""),
    color: text("color").notNull().default("yellow"),
    comment: text("comment").notNull().default(""),
    /** The highlighted text could not be found in a newer version of the PDF. */
    anchorLost: boolean("anchor_lost").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(selected_text, '')), 'A') || setweight(to_tsvector('english', coalesce(comment, '')), 'A')`,
    ),
    ...timestamps,
  },
  (t) => [
    index("highlights_file_page_idx").on(t.fileId, t.pageNumber),
    index("highlights_ws_paper_idx").on(t.workspaceId, t.paperId),
    index("highlights_search_idx").using("gin", t.searchVector),
  ],
);

// ---------------------------------------------------------------------------
// AI (optional)
// ---------------------------------------------------------------------------

export const aiProviderKind = pgEnum("ai_provider_kind", [
  "openai",
  "anthropic",
  "openai_compatible",
  "ollama",
  "local",
  "mock",
  "claude_code",
  "codex",
]);

export const aiConfigs = pgTable("ai_configs", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: aiProviderKind("provider").notNull(),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  /** AES-256-GCM encrypted; never returned to clients. */
  apiKeyEncrypted: text("api_key_encrypted"),
  apiKeyLast4: text("api_key_last4"),
  /** Reasoning effort (low…max); null means the provider's default. */
  effort: text("effort").$type<AiEffort>(),
  /** Local models: how much context they get and whether they read images. */
  localSettings: jsonb("local_settings").$type<LocalModelSettings>(),
  enabled: boolean("enabled").notNull().default(true),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

/** Settings remembered per provider (the active one is copied into ai_configs). */
export const aiProviderSettings = pgTable(
  "ai_provider_settings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: aiProviderKind("provider").notNull(),
    baseUrl: text("base_url"),
    model: text("model").notNull(),
    /** AES-256-GCM encrypted; never returned to clients. */
    apiKeyEncrypted: text("api_key_encrypted"),
    apiKeyLast4: text("api_key_last4"),
    effort: text("effort").$type<AiEffort>(),
    localSettings: jsonb("local_settings").$type<LocalModelSettings>(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })],
);

export const aiResults = pgTable(
  "ai_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id").references(() => papers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    provider: aiProviderKind("provider").notNull(),
    model: text("model").notNull(),
    /** What the model was given to read (AiBasis); null for results from before this was recorded. */
    basis: jsonb("basis").$type<AiBasis>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_results_ws_paper_kind_idx").on(t.workspaceId, t.paperId, t.kind, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const shareResource = pgEnum("share_resource", ["collection", "note", "concept"]);
export const sharePermission = pgEnum("share_permission", ["view", "edit"]);

export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceType: shareResource("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** Share with a specific registered user… */
    granteeUserId: text("grantee_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** …or anyone holding the link (view-only). */
    linkToken: text("link_token").unique(),
    permission: sharePermission("permission").notNull().default("view"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shares_one_audience", sql`num_nonnulls(${t.granteeUserId}, ${t.linkToken}) = 1`),
    check("shares_link_view_only", sql`${t.linkToken} is null or ${t.permission} = 'view'`),
    uniqueIndex("shares_resource_grantee_uq")
      .on(t.resourceType, t.resourceId, t.granteeUserId)
      .where(sql`${t.granteeUserId} is not null`),
    index("shares_resource_idx").on(t.resourceType, t.resourceId),
    index("shares_grantee_idx").on(t.granteeUserId),
  ],
);

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: jobStatus("status").notNull().default("queued"),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    /** Prevents enqueuing the same pending work twice. */
    dedupeKey: text("dedupe_key"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result"),
    ...timestamps,
  },
  (t) => [
    index("jobs_queue_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_uq")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("jobs_ws_idx").on(t.workspaceId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// AI research assistant
// ---------------------------------------------------------------------------

export const researchThreads = pgTable(
  "research_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** { paperIds: string[], collectionId: string | null } — material the user pointed the research at. */
    scope: jsonb("scope").$type<ResearchScope>().notNull().default({ paperIds: [], collectionId: null }),
    /** Where it was started: the Assistant page or the PDF reader (one paper in scope). */
    origin: text("origin").$type<ResearchOrigin>().notNull().default("assistant"),
    ...timestamps,
  },
  (t) => [index("research_threads_ws_idx").on(t.workspaceId, t.updatedAt)],
);

export const researchMessages = pgTable(
  "research_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => researchThreads.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull().default(""),
    mode: text("mode").$type<ResearchMode>().notNull().default("chat"),
    status: text("status").$type<ResearchStatus>().notNull().default("done"),
    error: text("error"),
    steps: jsonb("steps").$type<ResearchStep[]>().notNull().default([]),
    sources: jsonb("sources").$type<ResearchSource[]>().notNull().default([]),
    /** Workspace changes the assistant proposed, and what happened to them. */
    changes: jsonb("changes").$type<ChangeSet>(),
    /** The AI's ranking of the cited sources (reading order and priority). */
    ranking: jsonb("ranking").$type<SourceRanking>(),
    /** User messages sent from the reader: the page on screen and the selected text. */
    context: jsonb("context").$type<ReaderContext>(),
    provider: aiProviderKind("provider"),
    model: text("model"),
    ...timestamps,
  },
  (t) => [index("research_messages_thread_idx").on(t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Saved searches (alerts) and systematic screening
// ---------------------------------------------------------------------------

/** A search run again every day; papers it finds later than the first run are new for the user. */
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    /** general, biomedical, openreview, or arxiv (the newest preprints). */
    source: text("source").$type<"general" | "biomedical" | "openreview" | "arxiv">().notNull().default("general"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("saved_searches_ws_query_uq").on(t.workspaceId, sql`lower(${t.query})`, t.source)],
);

export const savedSearchResults = pgTable(
  "saved_search_results",
  {
    searchId: uuid("search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
    /** Results of the first run, and results the user has looked at, are seen. */
    seen: boolean("seen").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.searchId, t.paperId] }),
    index("saved_search_results_unseen_idx").on(t.searchId, t.seen),
  ],
);

/** Screening a set of papers against inclusion / exclusion criteria (systematic review), resumably. */
export const screenings = pgTable("screenings", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  criteria: text("criteria").notNull(),
  /** Decide from the full text where available (slower), not only the title and abstract. */
  useFullText: boolean("use_full_text").notNull().default(false),
  status: text("status").$type<"running" | "paused" | "done">().notNull().default("running"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

export const screeningItems = pgTable(
  "screening_items",
  {
    screeningId: uuid("screening_id")
      .notNull()
      .references(() => screenings.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    decision: text("decision").$type<"pending" | "include" | "exclude" | "maybe">().notNull().default("pending"),
    reason: text("reason").notNull().default(""),
    /** The passage the decision rests on. */
    evidence: text("evidence").notNull().default(""),
    decidedBy: text("decided_by").$type<"ai" | "user">(),
    error: text("error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.screeningId, t.paperId] }),
    index("screening_items_decision_idx").on(t.screeningId, t.decision),
  ],
);
