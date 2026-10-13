ALTER TYPE "public"."ai_provider_kind" ADD VALUE 'local' BEFORE 'mock';--> statement-breakpoint
ALTER TABLE "ai_configs" ADD COLUMN "local_settings" jsonb;--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD COLUMN "local_settings" jsonb;