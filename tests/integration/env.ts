import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Environment for integration tests: isolated database, local file storage, mock AI.
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://paperweave:paperweave@localhost:5433/paperweave_test",
  BETTER_AUTH_SECRET: "integration-test-secret-integration-test-secret",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_URL: "http://localhost:3300",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: mkdtempSync(path.join(tmpdir(), "paperweave-test-")),
  AI_ENABLE_MOCK_PROVIDER: "true",
  RUN_WORKER_IN_PROCESS: "false",
  // No model downloads in tests; tests that need meaning-based search install a stand-in model.
  EMBEDDINGS: "false",
});
