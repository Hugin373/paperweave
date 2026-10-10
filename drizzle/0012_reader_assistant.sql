ALTER TABLE "research_messages" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "research_threads" ADD COLUMN "origin" text DEFAULT 'assistant' NOT NULL;