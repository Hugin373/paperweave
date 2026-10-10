/**
 * Subscription providers: run the official Claude Code / Codex CLIs that are installed and signed
 * in on the server machine, so requests use that person's Claude or ChatGPT plan. The login never
 * leaves the CLI. Each request is a fresh, non-interactive run in an empty temporary directory with
 * no session persistence; Claude Code gets no tools at all and Codex runs in its read-only sandbox.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AiEffort } from "@/lib/types";
import { AIError, type AIProvider, type ChatMessage, type CompletionRequest, type ProviderConfig } from "../types";

export const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";
/** Empty means "the CLI's own default model". */
export const CODEX_DEFAULT_MODEL = "";

/** Linux limits a single argument to 128 KiB; larger system prompts are sent with the prompt instead. */
const MAX_ARG_BYTES = 100_000;
/** CLI runs include agent start-up and can be slower than direct API calls. */
const MIN_CLI_TIMEOUT_MS = 300_000;

/**
 * Variables that must not leak into the child: markers of a parent Claude Code session (which would
 * make the child think it is nested), and API keys that would switch the CLI from the subscription
 * to pay-as-you-go API billing.
 */
const STRIPPED_ENV =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|EXECPATH)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/;

function childEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIPPED_ENV.test(k)) out[k] = v;
  return out as NodeJS.ProcessEnv;
}

/** Flattens a conversation into a single prompt (the CLIs take one prompt per run). */
export function cliPrompt(messages: ChatMessage[], inlineSystem?: string): string {
  const last = messages.at(-1)?.content ?? "";
  const earlier = messages.slice(0, -1);
  const parts: string[] = [];
  if (inlineSystem) parts.push(`<instructions>\n${inlineSystem}\n</instructions>`);
  if (earlier.length) {
    parts.push(
      `Earlier conversation:\n<conversation>\n${earlier
        .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
        .join("\n")}\n</conversation>`,
      `Reply to this latest message:\n${last}`,
    );
  } else {
    parts.push(last);
  }
  return parts.join("\n\n");
}

/** Splits the system prompt between a CLI argument and the prompt, respecting argument size limits. */
function placeSystem(req: CompletionRequest) {
  if (Buffer.byteLength(req.system) <= MAX_ARG_BYTES) {
    return { systemArg: req.system, prompt: cliPrompt(req.messages) };
  }
  return {
    systemArg: "Follow the instructions in the <instructions> block of the message.",
    prompt: cliPrompt(req.messages, req.system),
  };
}

export type JsonEvent = Record<string, unknown> & { type?: string };

interface RunOptions {
  bin: string;
  args: (dir: string) => string[];
  /** Writes files the run needs (e.g. images) into its directory before it starts. */
  prepare?: (dir: string) => Promise<void>;
  input: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Shown in errors, e.g. "Claude Code". */
  label: string;
  installHint: string;
}

/**
 * Runs a CLI in a throwaway directory and yields its JSONL stdout events. The process is killed
 * when the consumer stops early, the request is aborted, or the timeout passes.
 */
export async function* runJsonLines(opts: RunOptions): AsyncGenerator<JsonEvent> {
  const dir = await mkdtemp(path.join(tmpdir(), "paperweave-ai-"));
  await opts.prepare?.(dir);
  const child = spawn(opts.bin, opts.args(dir), {
    cwd: dir,
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let spawnError: NodeJS.ErrnoException | null = null;
  let stderr = "";
  let timedOut = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  child.stdin.on("error", () => {
    /* the process exited before reading its input; reported through the exit status */
  });
  child.stdin.end(opts.input);

  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  opts.signal?.addEventListener("abort", kill, { once: true });

  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let event: JsonEvent;
      try {
        event = JSON.parse(trimmed) as JsonEvent;
      } catch {
        continue;
      }
      yield event;
    }
    const code = await exited;
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (timedOut) throw new AIError("timeout", `${opts.label} took too long to respond.`);
    const err = spawnError as NodeJS.ErrnoException | null;
    if (err) {
      throw new AIError(
        "not_configured",
        err.code === "ENOENT"
          ? `${opts.label} is not installed on the Paperweave server (could not run "${opts.bin}"). ${opts.installHint}`
          : `${opts.label} could not be started: ${err.message}`,
      );
    }
    if (code !== 0 && code !== null) {
      throw new CliExitError(code, stderr.trim());
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
    kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The CLI exited unsuccessfully without a structured error event. */
export class CliExitError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`exited with code ${code}`);
  }
}

const LOGIN_HINT = /not logged in|log ?in|\/login|unauthori[sz]ed|authentication|invalid api key|401/i;
const LIMIT_HINT = /usage limit|rate limit|limit reached|too many requests|429|quota/i;

function lastLine(text: string) {
  return text.split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? "";
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  stop_reason?: string | null;
}

export function claudeCodeError(result: ClaudeResult, errorCode: string | null, model = ""): AIError {
  const text = (result.result ?? "").trim();
  const status = result.api_error_status ?? null;
  if (status === 401 || status === 403 || errorCode === "authentication_failed" || LOGIN_HINT.test(text)) {
    return new AIError(
      "auth",
      "Claude Code is not signed in on the Paperweave server. Run `claude` in a terminal on that machine and log in with your Claude account.",
    );
  }
  if (status === 429 || errorCode === "rate_limit" || LIMIT_HINT.test(text)) {
    return new AIError("rate_limited", `Your Claude plan's usage limit was reached. ${text}`.trim());
  }
  if (status === 404 || errorCode === "model_not_found") {
    return new AIError(
      "bad_request",
      `The Claude model "${model}" is not available to this Claude Code account. Check the model in Settings → AI.`,
    );
  }
  return new AIError("unavailable", text ? `Claude Code failed: ${text}` : "Claude Code failed unexpectedly.");
}

/** Claude through the Claude Code CLI (`claude -p`), using the signed-in Claude subscription. */
export class ClaudeCodeProvider implements AIProvider {
  readonly kind = "claude_code" as const;
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly effort: AiEffort | null;

  constructor(cfg: ProviderConfig & { bin: string }) {
    this.model = cfg.model || CLAUDE_CODE_DEFAULT_MODEL;
    this.effort = cfg.effort ?? null;
    this.bin = cfg.bin;
    this.timeoutMs = Math.max(cfg.timeoutMs, MIN_CLI_TIMEOUT_MS);
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const { systemArg, prompt } = placeSystem(req);
    // With images, the prompt goes in as one stream-json user message holding image and text blocks.
    const images = req.images ?? [];
    const input = images.length
      ? `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              ...images.map((img) => ({
                type: "image",
                source: { type: "base64", media_type: img.mediaType, data: img.data },
              })),
              { type: "text", text: prompt },
            ],
          },
        })}\n`
      : prompt;
    const events = runJsonLines({
      bin: this.bin,
      label: "Claude Code",
      installHint: "Install Claude Code and run `claude` once to sign in.",
      input,
      signal: req.signal,
      timeoutMs: this.timeoutMs,
      args: () => [
        "-p",
        ...(images.length ? ["--input-format", "stream-json"] : []),
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        // No tools: the model can only answer; it cannot read files, run commands or browse.
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--model",
        this.model,
        ...(this.effort ? ["--effort", this.effort] : []),
        "--system-prompt",
        systemArg,
      ],
    });
    let produced = false;
    let result: ClaudeResult | null = null;
    let errorCode: string | null = null;
    try {
      for await (const ev of events) {
        if (ev.type === "system" && ev.subtype === "init") {
          req.onProgress?.("Starting Claude Code");
        } else if (ev.type === "stream_event") {
          const event = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
          if (event?.type === "message_start" && !produced) req.onProgress?.("Thinking");
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            produced = true;
            yield event.delta.text;
          }
        } else if (ev.type === "assistant" && typeof ev.error === "string") {
          errorCode = ev.error;
        } else if (ev.type === "result") {
          result = ev as ClaudeResult;
        }
      }
    } catch (err) {
      if (err instanceof CliExitError) {
        throw result
          ? claudeCodeError(result, errorCode, this.model)
          : claudeCodeError({ result: lastLine(err.stderr) }, errorCode, this.model);
      }
      throw err;
    }
    if (!result) throw new AIError("unavailable", "Claude Code ended without an answer.");
    if (result.is_error) throw claudeCodeError(result, errorCode, this.model);
    if (result.stop_reason === "refusal") throw new AIError("refused", "The model declined this request.");
    if (!produced && result.result) yield result.result;
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Codex error messages are often a JSON-encoded API error; extracts its status and message. */
export function codexError(raw: string): AIError {
  let status: number | null = null;
  let message = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { status?: number; error?: { message?: string } };
    status = parsed.status ?? null;
    message = parsed.error?.message ?? message;
  } catch {
    /* plain text */
  }
  if (status === 401 || status === 403 || (status === null && LOGIN_HINT.test(message))) {
    return new AIError(
      "auth",
      "Codex is not signed in on the Paperweave server. Run `codex login` in a terminal on that machine and sign in with your ChatGPT account.",
    );
  }
  if (status === 429 || LIMIT_HINT.test(message)) {
    return new AIError("rate_limited", `Your ChatGPT plan's Codex usage limit was reached. ${message}`.trim());
  }
  if (status === 400 || status === 404) return new AIError("bad_request", message);
  return new AIError("unavailable", message ? `Codex failed: ${message}` : "Codex failed unexpectedly.");
}

/** A one-line progress note from a Codex reasoning summary ("**Comparing results**\n\n…") or preamble. */
export function codexProgressNote(text: string): string | null {
  const heading = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
  const line = (heading ?? text.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#]/g, "").trim();
  if (!line) return null;
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

/** OpenAI models through the Codex CLI (`codex exec`), using the signed-in ChatGPT subscription. */
export class CodexProvider implements AIProvider {
  readonly kind = "codex" as const;
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly effort: AiEffort | null;

  constructor(cfg: ProviderConfig & { bin: string }) {
    this.model = cfg.model || CODEX_DEFAULT_MODEL;
    this.effort = cfg.effort ?? null;
    this.bin = cfg.bin;
    this.timeoutMs = Math.max(cfg.timeoutMs, MIN_CLI_TIMEOUT_MS);
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const { systemArg, prompt } = placeSystem(req);
    const images = (req.images ?? []).map((img, i) => ({
      ...img,
      file: `image-${i + 1}.${img.mediaType === "image/png" ? "png" : "jpg"}`,
    }));
    const events = runJsonLines({
      bin: this.bin,
      label: "Codex",
      installHint: "Install the Codex CLI and run `codex login` to sign in.",
      input: prompt,
      signal: req.signal,
      timeoutMs: this.timeoutMs,
      prepare: async (dir) => {
        for (const img of images) await writeFile(path.join(dir, img.file), Buffer.from(img.data, "base64"));
      },
      args: (dir) => [
        "exec",
        ...images.flatMap((img) => ["--image", path.join(dir, img.file)]),
        "--json",
        // Read-only sandbox in an empty directory; user config, MCP servers and rules are ignored.
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        dir,
        // A JSON string literal is also a valid TOML basic string.
        "-c",
        `developer_instructions=${JSON.stringify(systemArg)}`,
        ...(this.model ? ["-m", this.model] : []),
        ...(this.effort ? ["-c", `model_reasoning_effort="${this.effort}"`] : []),
        // Short reasoning summaries, shown as progress while Codex works (it does not stream its answer).
        "-c",
        'model_reasoning_summary="auto"',
        "-",
      ],
    });
    // Codex reports whole messages; the last one of the turn is the answer (earlier ones are preambles).
    let answer: string | null = null;
    let failure: string | null = null;
    try {
      for await (const ev of events) {
        const item = ev.item as { type?: string; text?: string } | undefined;
        if (ev.type === "thread.started") {
          req.onProgress?.("Starting Codex");
        } else if (ev.type === "turn.started") {
          req.onProgress?.("Thinking");
        } else if (ev.type === "item.completed" && item?.type === "reasoning" && typeof item.text === "string") {
          const note = codexProgressNote(item.text);
          if (note) req.onProgress?.(note);
        } else if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          // An earlier message was a preamble ("I'll look at…"); show it as progress.
          if (answer) req.onProgress?.(codexProgressNote(answer) ?? "Working");
          answer = item.text;
        } else if (ev.type === "error" && typeof ev.message === "string") {
          failure = ev.message;
        } else if (ev.type === "turn.failed") {
          failure = (ev.error as { message?: string } | undefined)?.message ?? failure ?? "The turn failed.";
        }
      }
    } catch (err) {
      if (err instanceof CliExitError) throw codexError(failure ?? lastLine(err.stderr));
      throw err;
    }
    if (failure && !answer) throw codexError(failure);
    if (!answer) throw new AIError("unavailable", "Codex ended without an answer.");
    yield answer;
  }
}
