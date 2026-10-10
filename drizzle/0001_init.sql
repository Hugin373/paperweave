CREATE TYPE "public"."ai_provider_kind" AS ENUM('openai', 'anthropic', 'openai_compatible', 'ollama', 'mock');--> statement-breakpoint
CREATE TYPE "public"."concept_origin" AS ENUM('user', 'ai_suggestion');--> statement-breakpoint
CREATE TYPE "public"."file_source" AS ENUM('upload', 'open_access', 'external_url');--> statement-breakpoint
CREATE TYPE "public"."highlight_kind" AS ENUM('highlight', 'note');--> statement-breakpoint
CREATE TYPE "public"."identifier_kind" AS ENUM('doi', 'arxiv', 's2', 'openalex', 'pmid', 'pmcid', 'corpus');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."paper_source" AS ENUM('semantic_scholar', 'openalex', 'crossref', 'arxiv', 'user');--> statement-breakpoint
CREATE TYPE "public"."reading_status" AS ENUM('saved', 'reading', 'read', 'archived');--> statement-breakpoint
CREATE TYPE "public"."share_permission" AS ENUM('view', 'edit');--> statement-breakpoint
CREATE TYPE "public"."share_resource" AS ENUM('collection', 'note', 'concept');--> statement-breakpoint
CREATE TYPE "public"."text_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_configs" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"provider" "ai_provider_kind" NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_last4" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paper_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"provider" "ai_provider_kind" NOT NULL,
	"model" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"citing_paper_id" uuid NOT NULL,
	"cited_paper_id" uuid NOT NULL,
	"is_influential" boolean,
	"intents" text[] DEFAULT '{}'::text[] NOT NULL,
	"contexts" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" "paper_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "citations_citing_paper_id_cited_paper_id_pk" PRIMARY KEY("citing_paper_id","cited_paper_id"),
	CONSTRAINT "citations_no_self" CHECK ("citations"."citing_paper_id" <> "citations"."cited_paper_id")
);
--> statement-breakpoint
CREATE TABLE "collection_papers" (
	"collection_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_papers_collection_id_paper_id_pk" PRIMARY KEY("collection_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_relations" (
	"concept_a_id" uuid NOT NULL,
	"concept_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_relations_concept_a_id_concept_b_id_pk" PRIMARY KEY("concept_a_id","concept_b_id"),
	CONSTRAINT "concept_relations_ordered" CHECK ("concept_relations"."concept_a_id" < "concept_relations"."concept_b_id")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"origin" "concept_origin" DEFAULT 'user' NOT NULL,
	"created_by" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', pw_array_to_text(aliases)), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" "highlight_kind" DEFAULT 'highlight' NOT NULL,
	"page_number" integer NOT NULL,
	"rects" jsonb NOT NULL,
	"selected_text" text DEFAULT '' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'yellow' NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"created_by" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(selected_text, '')), 'A') || setweight(to_tsvector('english', coalesce(comment, '')), 'A')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"workspace_id" uuid,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"workspace_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"status" "reading_status" DEFAULT 'saved' NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_items_workspace_id_paper_id_pk" PRIMARY KEY("workspace_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"target_paper_id" uuid,
	"target_concept_id" uuid,
	"target_note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_links_one_target" CHECK (num_nonnulls("note_links"."target_paper_id", "note_links"."target_concept_id", "note_links"."target_note_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paper_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"content" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_concepts" (
	"concept_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_concepts_concept_id_paper_id_pk" PRIMARY KEY("concept_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "paper_file_pages" (
	"file_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
	CONSTRAINT "paper_file_pages_file_id_page_number_pk" PRIMARY KEY("file_id","page_number")
);
--> statement-breakpoint
CREATE TABLE "paper_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"source" "file_source" NOT NULL,
	"source_url" text,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"page_count" integer,
	"text_status" text_status DEFAULT 'pending' NOT NULL,
	"text_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "paper_identifiers" (
	"paper_id" uuid NOT NULL,
	"kind" "identifier_kind" NOT NULL,
	"value" text NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	CONSTRAINT "paper_identifiers_scope_kind_value_pk" PRIMARY KEY("scope","kind","value")
);
--> statement-breakpoint
CREATE TABLE "paper_tags" (
	"tag_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_tags_tag_id_paper_id_pk" PRIMARY KEY("tag_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_workspace_id" uuid,
	"source" "paper_source" NOT NULL,
	"title" text NOT NULL,
	"abstract" text,
	"year" integer,
	"publication_date" date,
	"venue" text,
	"publication_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"fields_of_study" text[] DEFAULT '{}'::text[] NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authors_text" text DEFAULT '' NOT NULL,
	"citation_count" integer,
	"reference_count" integer,
	"influential_citation_count" integer,
	"is_open_access" boolean,
	"open_access_pdf_url" text,
	"url" text,
	"title_norm" text NOT NULL,
	"first_author_norm" text,
	"metadata_refreshed_at" timestamp with time zone,
	"references_synced_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(authors_text, '')), 'B') || setweight(to_tsvector('english', coalesce(abstract, '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_type" "share_resource" NOT NULL,
	"resource_id" uuid NOT NULL,
	"grantee_user_id" text,
	"link_token" text,
	"permission" "share_permission" DEFAULT 'view' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_link_token_unique" UNIQUE("link_token"),
	CONSTRAINT "shares_one_audience" CHECK (num_nonnulls("shares"."grantee_user_id", "shares"."link_token") = 1),
	CONSTRAINT "shares_link_view_only" CHECK ("shares"."link_token" is null or "shares"."permission" = 'view')
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"onboarding_dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_personal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_citing_paper_id_papers_id_fk" FOREIGN KEY ("citing_paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_cited_paper_id_papers_id_fk" FOREIGN KEY ("cited_paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_papers" ADD CONSTRAINT "collection_papers_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_papers" ADD CONSTRAINT "collection_papers_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_relations" ADD CONSTRAINT "concept_relations_concept_a_id_concepts_id_fk" FOREIGN KEY ("concept_a_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_relations" ADD CONSTRAINT "concept_relations_concept_b_id_concepts_id_fk" FOREIGN KEY ("concept_b_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_file_id_paper_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."paper_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_paper_id_papers_id_fk" FOREIGN KEY ("target_paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_concept_id_concepts_id_fk" FOREIGN KEY ("target_concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_note_id_notes_id_fk" FOREIGN KEY ("target_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_concepts" ADD CONSTRAINT "paper_concepts_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_concepts" ADD CONSTRAINT "paper_concepts_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_concepts" ADD CONSTRAINT "paper_concepts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_file_pages" ADD CONSTRAINT "paper_file_pages_file_id_paper_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."paper_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_files" ADD CONSTRAINT "paper_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_files" ADD CONSTRAINT "paper_files_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_files" ADD CONSTRAINT "paper_files_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_identifiers" ADD CONSTRAINT "paper_identifiers_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_tags" ADD CONSTRAINT "paper_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_tags" ADD CONSTRAINT "paper_tags_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_owner_workspace_id_workspaces_id_fk" FOREIGN KEY ("owner_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_results_ws_paper_kind_idx" ON "ai_results" USING btree ("workspace_id","paper_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "citations_cited_idx" ON "citations" USING btree ("cited_paper_id");--> statement-breakpoint
CREATE INDEX "collection_papers_paper_idx" ON "collection_papers" USING btree ("paper_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_ws_name_uq" ON "collections" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "concept_relations_b_idx" ON "concept_relations" USING btree ("concept_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_ws_name_uq" ON "concepts" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "concepts_search_idx" ON "concepts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "external_cache_expires_idx" ON "external_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "highlights_file_page_idx" ON "highlights" USING btree ("file_id","page_number");--> statement-breakpoint
CREATE INDEX "highlights_ws_paper_idx" ON "highlights" USING btree ("workspace_id","paper_id");--> statement-breakpoint
CREATE INDEX "highlights_search_idx" ON "highlights" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_ws_idx" ON "jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "library_items_ws_status_idx" ON "library_items" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "library_items_paper_idx" ON "library_items" USING btree ("paper_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_links_paper_uq" ON "note_links" USING btree ("note_id","target_paper_id") WHERE "note_links"."target_paper_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "note_links_concept_uq" ON "note_links" USING btree ("note_id","target_concept_id") WHERE "note_links"."target_concept_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "note_links_note_uq" ON "note_links" USING btree ("note_id","target_note_id") WHERE "note_links"."target_note_id" is not null;--> statement-breakpoint
CREATE INDEX "note_links_target_paper_idx" ON "note_links" USING btree ("target_paper_id");--> statement-breakpoint
CREATE INDEX "note_links_target_concept_idx" ON "note_links" USING btree ("target_concept_id");--> statement-breakpoint
CREATE INDEX "note_links_target_note_idx" ON "note_links" USING btree ("target_note_id");--> statement-breakpoint
CREATE INDEX "notes_ws_updated_idx" ON "notes" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "notes_paper_idx" ON "notes" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "paper_concepts_paper_idx" ON "paper_concepts" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "paper_file_pages_search_idx" ON "paper_file_pages" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_files_ws_paper_sha_uq" ON "paper_files" USING btree ("workspace_id","paper_id","sha256");--> statement-breakpoint
CREATE INDEX "paper_files_ws_paper_idx" ON "paper_files" USING btree ("workspace_id","paper_id");--> statement-breakpoint
CREATE INDEX "paper_identifiers_paper_idx" ON "paper_identifiers" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "paper_tags_paper_idx" ON "paper_tags" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "papers_title_norm_idx" ON "papers" USING btree ("title_norm");--> statement-breakpoint
CREATE INDEX "papers_search_idx" ON "papers" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "papers_title_trgm_idx" ON "papers" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "papers_owner_idx" ON "papers" USING btree ("owner_workspace_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_resource_grantee_uq" ON "shares" USING btree ("resource_type","resource_id","grantee_user_id") WHERE "shares"."grantee_user_id" is not null;--> statement-breakpoint
CREATE INDEX "shares_resource_idx" ON "shares" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "shares_grantee_idx" ON "shares" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_ws_name_uq" ON "tags" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");