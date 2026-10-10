CREATE TABLE "text_embeddings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"file_id" uuid,
	"paper_id" uuid,
	"note_id" uuid,
	"page" integer,
	"chunk" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"vector" real[] NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "text_embeddings" ADD CONSTRAINT "text_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_embeddings" ADD CONSTRAINT "text_embeddings_file_id_paper_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."paper_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_embeddings" ADD CONSTRAINT "text_embeddings_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_embeddings" ADD CONSTRAINT "text_embeddings_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "text_embeddings_ws_idx" ON "text_embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "text_embeddings_file_idx" ON "text_embeddings" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "text_embeddings_note_idx" ON "text_embeddings" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "text_embeddings_paper_idx" ON "text_embeddings" USING btree ("paper_id","source_kind");