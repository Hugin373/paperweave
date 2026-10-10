import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeProvider, cliPrompt, CodexProvider, codexError, codexProgressNote } from "@/server/ai/providers/cli";
import { AIError, complete } from "@/server/ai/types";

let dir: string;

/**
 * Writes an executable fake CLI. It records its arguments, stdin and environment next to itself
 * and prints the given JSONL lines (or exits with a code).
 */
async function fakeCli(name: string, lines: unknown[], opts: { exitCode?: number; stderr?: string } = {}) {
  const file = path.join(dir, name);
  const out = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  await writeFile(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(`${file}.call.json`)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), env: process.env }));
  process.stdout.write(${JSON.stringify(out)} + "\\n");
  ${opts.stderr ? `process.stderr.write(${JSON.stringify(opts.stderr)});` : ""}
  process.exit(${opts.exitCode ?? 0});
});
`,
  );
  await chmod(file, 0o755);
  return {
    bin: file,
    call: async () =>
      JSON.parse(await readFile(`${file}.call.json`, "utf8")) as {
        args: string[];
        input: string;
        cwd: string;
        env: Record<string, string>;
      },
  };
}

const base = { baseUrl: null, apiKey: null, timeoutMs: 20_000, fetch };
const req = { system: "Be brief.", messages: [{ role: "user" as const, content: "Hello?" }] };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pw-fake-cli-"));
});

describe("cliPrompt", () => {
  it("sends a single message as is and flattens conversations", () => {
    expect(cliPrompt([{ role: "user", content: "Hi" }])).toBe("Hi");
    const flat = cliPrompt(
      [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
        { role: "user", content: "C" },
      ],
      "SYS",
    );
    expect(flat).toContain("<instructions>\nSYS\n</instructions>");
    expect(flat).toContain("<user>\nA\n</user>\n<assistant>\nB\n</assistant>");
    expect(flat.endsWith("Reply to this latest message:\nC")).toBe(true);
  });
});

describe("Claude Code provider", () => {
  it("streams text deltas, disables tools and strips nested-session and API-key variables", async () => {
    const cli = await fakeCli("claude-ok", [
      { type: "system", subtype: "init" },
      "not json noise",
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo." } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Hello." },
    ]);
    process.env.CLAUDECODE = "1";
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const p = new ClaudeCodeProvider({ ...base, kind: "claude_code", model: "haiku", bin: cli.bin });
      const chunks: string[] = [];
      for await (const c of p.stream(req)) chunks.push(c);
      expect(chunks).toEqual(["Hel", "lo."]);
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.ANTHROPIC_API_KEY;
    }
    const call = await cli.call();
    expect(call.input).toBe("Hello?");
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]));
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("haiku");
    expect(call.args[call.args.indexOf("--system-prompt") + 1]).toBe("Be brief.");
    expect(call.args).not.toContain("--effort");
    expect(call.cwd).toContain("paperweave-ai-");
    expect(call.env.CLAUDECODE).toBeUndefined();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("maps sign-in, usage-limit and model errors", async () => {
    const run = async (name: string, result: object, error?: string) => {
      const cli = await fakeCli(name, [
        ...(error ? [{ type: "assistant", error, message: { content: [] } }] : []),
        { type: "result", subtype: "success", is_error: true, ...result },
      ]);
      const p = new ClaudeCodeProvider({ ...base, kind: "claude_code", model: "opus", bin: cli.bin });
      return complete(p, req).catch((e: AIError) => e);
    };
    expect(await run("c-auth", { result: "Not logged in · Please run /login" })).toMatchObject({ kind: "auth" });
    expect(await run("c-limit", { result: "Claude usage limit reached", api_error_status: 429 })).toMatchObject({
      kind: "rate_limited",
    });
    const model = await run(
      "c-model",
      { result: "issue with the selected model", api_error_status: 404 },
      "model_not_found",
    );
    expect(model).toMatchObject({ kind: "bad_request" });
    expect((model as AIError).message).toContain('"opus"');
  });

  it("passes the effort level", async () => {
    const cli = await fakeCli("claude-effort", [{ type: "result", subtype: "success", is_error: false, result: "Hi" }]);
    const p = new ClaudeCodeProvider({ ...base, kind: "claude_code", model: "opus", effort: "xhigh", bin: cli.bin });
    expect(await complete(p, req)).toBe("Hi");
    const { args } = await cli.call();
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("explains when the CLI is not installed", async () => {
    const p = new ClaudeCodeProvider({ ...base, kind: "claude_code", model: "", bin: path.join(dir, "missing") });
    await expect(complete(p, req)).rejects.toMatchObject({ kind: "not_configured" });
  });
});

describe("Codex provider", () => {
  it("returns the last agent message, runs read-only and passes instructions", async () => {
    const cli = await fakeCli("codex-ok", [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "error", message: "Model metadata not found" } },
      { type: "item.completed", item: { type: "agent_message", text: "Let me think." } },
      { type: "item.completed", item: { type: "agent_message", text: "Final answer." } },
      { type: "turn.completed", usage: {} },
    ]);
    const p = new CodexProvider({ ...base, kind: "codex", model: "", bin: cli.bin });
    const progress: string[] = [];
    expect(await complete(p, { ...req, onProgress: (s) => progress.push(s) })).toBe("Final answer.");
    // Codex does not stream its answer, so its preambles are shown as progress instead.
    expect(progress).toEqual(["Starting Codex", "Let me think."]);
    const call = await cli.call();
    expect(call.args).toContain('model_reasoning_summary="auto"');
    expect(call.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(call.args[call.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(call.args).toContain("--ephemeral");
    expect(call.args).toContain('developer_instructions="Be brief."');
    expect(call.args).not.toContain("-m");
    expect(call.args.at(-1)).toBe("-");
  });

  it("passes the reasoning effort as a config override", async () => {
    const cli = await fakeCli("codex-effort", [
      { type: "item.completed", item: { type: "agent_message", text: "Hi" } },
    ]);
    const p = new CodexProvider({ ...base, kind: "codex", model: "gpt-x", effort: "high", bin: cli.bin });
    expect(await complete(p, req)).toBe("Hi");
    const { args } = await cli.call();
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-x", 'model_reasoning_effort="high"']));
  });

  it("maps failed turns", async () => {
    const apiError = JSON.stringify({ type: "error", status: 400, error: { message: "Model not supported." } });
    const cli = await fakeCli(
      "codex-fail",
      [
        { type: "error", message: apiError },
        { type: "turn.failed", error: { message: apiError } },
      ],
      { exitCode: 1 },
    );
    const p = new CodexProvider({ ...base, kind: "codex", model: "x", bin: cli.bin });
    await expect(complete(p, req)).rejects.toMatchObject({ kind: "bad_request", message: "Model not supported." });
  });

  it("reports reasoning summaries as short progress notes", async () => {
    const cli = await fakeCli("codex-progress", [
      { type: "turn.started" },
      { type: "item.completed", item: { type: "reasoning", text: "**Reading the methods**\n\nThe paper uses…" } },
      { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    ]);
    const p = new CodexProvider({ ...base, kind: "codex", model: "", bin: cli.bin });
    const progress: string[] = [];
    expect(await complete(p, { ...req, onProgress: (s) => progress.push(s) })).toBe("Done.");
    expect(progress).toEqual(["Thinking", "Reading the methods"]);
    expect(codexProgressNote(`plain ${"x".repeat(200)}`)?.length).toBeLessThanOrEqual(90);
    expect(codexProgressNote("  \n ")).toBeNull();
  });

  it("classifies plain-text errors", () => {
    expect(codexError("You are not logged in")).toMatchObject({ kind: "auth" });
    expect(codexError(JSON.stringify({ status: 429, error: { message: "Usage limit reached" } }))).toMatchObject({
      kind: "rate_limited",
    });
    expect(codexError("boom")).toMatchObject({ kind: "unavailable" });
  });
});
