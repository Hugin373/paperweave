ALTER TABLE "paper_files" ALTER COLUMN "storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "highlights" ADD COLUMN "anchor_lost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_files" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "paper_files" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paper_files" ADD COLUMN "version_notice" jsonb;