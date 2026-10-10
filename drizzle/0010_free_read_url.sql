ALTER TABLE "papers" ADD COLUMN "free_read_url" text;--> statement-breakpoint
-- Re-run the free-PDF check for papers checked before free-to-read pages were recorded.
UPDATE "papers" SET "oa_checked_at" = NULL WHERE "open_access_pdf_url" IS NULL AND "oa_checked_at" IS NOT NULL;
