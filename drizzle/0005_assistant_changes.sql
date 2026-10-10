ALTER TABLE "research_messages" ALTER COLUMN "mode" SET DEFAULT 'chat';--> statement-breakpoint
ALTER TABLE "research_messages" ADD COLUMN "changes" jsonb;--> statement-breakpoint
-- "Quick answer" became the "search" mode of the assistant.
UPDATE "research_messages" SET "mode" = 'search' WHERE "mode" = 'quick';
