import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true" || v === "1"));

/** Like bool(), but undefined when unset so the default can depend on other variables. */
const optionalBool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v === "true" || v === "1"));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3300"),
  /** Other addresses the app is opened at (comma-separated), e.g. a Tailscale https URL. */
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
        .map((o) => new URL(o).origin),
    ),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  APP_ENCRYPTION_KEY: optionalString,

  STORAGE_DRIVER: z.enum(["s3", "local"]).default("s3"),
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("paperweave"),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: bool(true),
  S3_AUTO_CREATE_BUCKET: bool(false),
  STORAGE_LOCAL_DIR: z.string().default("./data/files"),
  MAX_PDF_MB: z.coerce.number().positive().default(60),

  SCHOLARLY_PROVIDERS: z.string().default("semantic_scholar,openalex"),
  SEMANTIC_SCHOLAR_API_KEY: optionalString,
  SCHOLARLY_CONTACT_EMAIL: optionalString,
  OPENALEX_API_KEY: optionalString,
  /** Optional OpenReview account: needed to read reviews and download PDFs (anonymous access is bot-checked). */
  OPENREVIEW_USERNAME: optionalString,
  OPENREVIEW_PASSWORD: optionalString,
  SCHOLARLY_CACHE_TTL_HOURS: z.coerce.number().positive().default(168),

  AI_ALLOW_PRIVATE_ENDPOINTS: bool(true),
  AI_ENABLE_MOCK_PROVIDER: bool(false),
  AI_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  /**
   * Lets workspaces use the Claude Code / Codex CLIs installed and signed in on this machine, so AI
   * runs on the operator's Claude or ChatGPT subscription. Defaults to on outside production only.
   */
  AI_ENABLE_SUBSCRIPTION_CLI: optionalBool,
  AI_CLAUDE_CODE_PATH: z.string().default("claude"),
  AI_CODEX_PATH: z.string().default("codex"),

  /**
   * Meaning-based search: a small embedding model runs locally (downloaded once on first use, about
   * 35 MB); nothing leaves this machine. Off: search matches words only.
   */
  EMBEDDINGS: bool(true),
  /** A Hugging Face model with ONNX weights. Multilingual alternative: Xenova/multilingual-e5-small. */
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),

  RUN_WORKER_IN_PROCESS: bool(true),
  /** Apply pending migrations on start (and refuse to start against a newer schema). */
  AUTO_MIGRATE: bool(true),
  /** Brute-force protection for sign-in/sign-up (production only). */
  AUTH_RATE_LIMIT: bool(true),
  ALLOW_REGISTRATION: bool(true),
  /**
   * Single-user mode: requests without a sign-in act as the account with this email, when addressed to
   * this computer, APP_URL or TRUSTED_ORIGINS. Only for an instance nobody else can reach.
   */
  SINGLE_USER_EMAIL: optionalString,
});

const withDefaults = schema.transform((e) => ({
  ...e,
  AI_ENABLE_SUBSCRIPTION_CLI: e.AI_ENABLE_SUBSCRIPTION_CLI ?? e.NODE_ENV !== "production",
}));

export type Env = z.infer<typeof withDefaults>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = withDefaults.safeParse(process.env);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${details}`);
    }
    cached = parsed.data;
  }
  return cached;
}
