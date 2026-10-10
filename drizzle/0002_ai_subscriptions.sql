ALTER TYPE "public"."ai_provider_kind" ADD VALUE 'claude_code';--> statement-breakpoint
ALTER TYPE "public"."ai_provider_kind" ADD VALUE 'codex';--> statement-breakpoint
CREATE TABLE "ai_provider_settings" (
	"workspace_id" uuid NOT NULL,
	"provider" "ai_provider_kind" NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_settings_workspace_id_provider_pk" PRIMARY KEY("workspace_id","provider")
);
--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD CONSTRAINT "ai_provider_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Remember the currently configured provider's settings.
INSERT INTO "ai_provider_settings" ("workspace_id", "provider", "base_url", "model", "api_key_encrypted", "api_key_last4")
SELECT "workspace_id", "provider", "base_url", "model", "api_key_encrypted", "api_key_last4" FROM "ai_configs";
