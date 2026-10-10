/**
 * Research resources around a paper — its code, datasets, models and project page — and reading them
 * (a repository's README, a config file, a web page), plus a calculator for working things out (e.g.
 * whether training fits on one GPU). Read-only; outside requests go through the safe fetch.
 */
import { loadPaperText } from "@/server/ai/paper-text";
import { readLimited, safeFetch, UnsafeUrlError } from "@/server/net/safe-fetch";
import { getVisiblePaper, identifiersFor } from "@/server/papers/service";
import { paperSource, ToolInputError, type ToolContext, type ToolResult } from "./tools";

const UA = { "User-Agent": "Paperweave/1.0 (+research assistant)" };
const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_SHOWN = 15_000;

// ---------------------------------------------------------------------------
// Finding resources
// ---------------------------------------------------------------------------

export type ResourceKind = "code" | "dataset" | "model" | "demo" | "data" | "project page" | "review";

/** What kind of research resource a URL is, or null for ordinary links (DOIs, references…). */
export function classifyUrl(raw: string): { kind: ResourceKind; url: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (["github.com", "gitlab.com", "bitbucket.org"].includes(host) && parts.length >= 2) {
    return { kind: "code", url: `https://${host}/${parts[0]}/${parts[1].replace(/\.git$/, "")}` };
  }
  if (host === "huggingface.co" && parts.length >= 2) {
    if (parts[0] === "datasets" && parts.length >= 3)
      return { kind: "dataset", url: `https://huggingface.co/datasets/${parts[1]}/${parts[2]}` };
    if (parts[0] === "spaces" && parts.length >= 3)
      return { kind: "demo", url: `https://huggingface.co/spaces/${parts[1]}/${parts[2]}` };
    if (!["papers", "docs", "blog"].includes(parts[0]))
      return { kind: "model", url: `https://huggingface.co/${parts[0]}/${parts[1]}` };
  }
  if (
    /(^|\.)(zenodo\.org|figshare\.com|kaggle\.com|osf\.io|dataverse\.[a-z.]+|physionet\.org|openneuro\.org)$/.test(host)
  ) {
    return { kind: "data", url: u.toString() };
  }
  if (host.endsWith(".github.io")) return { kind: "project page", url: u.toString().replace(/\/$/, "") };
  return null;
}

/** Resource links in a paper's text, with the page each was first seen on. */
export function resourceLinks(parts: { n: number; text: string }[]) {
  const found = new Map<string, { kind: ResourceKind; url: string; page: number }>();
  for (const p of parts) {
    // PDF text often breaks URLs at line ends; join "github.com/ name" back together.
    const text = p.text.replace(/(https?:\/\/\S+?)\s+(?=[\w-]+\/)/g, "$1");
    for (const m of text.matchAll(
      /https?:\/\/[^\s<>()"'\]]+|(?:github\.com|gitlab\.com|huggingface\.co)\/[^\s<>()"'\]]+/g,
    )) {
      const raw = m[0].replace(/[.,;:]+$/, "");
      const c = classifyUrl(raw.startsWith("http") ? raw : `https://${raw}`);
      if (c && !found.has(c.url)) found.set(c.url, { ...c, page: p.n });
    }
  }
  return [...found.values()];
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await safeFetch(url, { timeoutMs: 15_000, headers: { ...UA, Accept: "application/json" } });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return JSON.parse(new TextDecoder().decode(await readLimited(res, MAX_BYTES))) as T;
  } catch {
    return null;
  }
}

interface HfRepos {
  models?: { id: string; likes?: number; downloads?: number }[];
  datasets?: { id: string; likes?: number; downloads?: number }[];
  spaces?: { id: string; likes?: number }[];
}

/**
 * A paper's code, datasets, models, demos and project page: links in its own text (with the page), the
 * repositories Hugging Face lists for its arXiv id, and its OpenReview discussion.
 */
export async function findResources(ctx: ToolContext, key: string): Promise<ToolResult> {
  const source = paperSource(ctx, key);
  await getVisiblePaper(ctx.workspaceId, source.id);
  const ids = (await identifiersFor([source.id])).get(source.id) ?? {};
  const lines: string[] = [];
  const seen = new Set<string>();

  const text = await loadPaperText(ctx.workspaceId, source.id).catch(() => null);
  for (const r of text ? resourceLinks(text.parts) : []) {
    seen.add(r.url);
    lines.push(
      `- ${r.kind}: ${r.url} — linked in the paper (${text?.unit === "section" ? "section" : "p."} ${r.page})`,
    );
  }

  if (ids.arxiv) {
    const [paper, repos] = await Promise.all([
      getJson<{ githubRepo?: string; projectPage?: string }>(`https://huggingface.co/api/papers/${ids.arxiv}`),
      getJson<HfRepos>(`https://huggingface.co/api/arxiv/${ids.arxiv}/repos`),
    ]);
    const add = (kind: ResourceKind, url: string, how: string) => {
      const c = classifyUrl(url);
      const norm = c?.url ?? url;
      if (seen.has(norm)) return;
      seen.add(norm);
      lines.push(`- ${kind}: ${norm} — ${how}`);
    };
    if (paper?.githubRepo) add("code", paper.githubRepo, "given on the paper's Hugging Face page");
    if (paper?.projectPage) add("project page", paper.projectPage, "given on the paper's Hugging Face page");
    const popular = <T extends { likes?: number; downloads?: number }>(list: T[] = []) =>
      [...list].sort((a, b) => (b.downloads ?? b.likes ?? 0) - (a.downloads ?? a.likes ?? 0)).slice(0, 6);
    for (const m of popular(repos?.models))
      add("model", `https://huggingface.co/${m.id}`, "a Hugging Face model citing the paper");
    for (const d of popular(repos?.datasets))
      add("dataset", `https://huggingface.co/datasets/${d.id}`, "a Hugging Face dataset citing the paper");
    for (const s of popular(repos?.spaces))
      add("demo", `https://huggingface.co/spaces/${s.id}`, "a Hugging Face demo citing the paper");
  }
  if (ids.openreview)
    lines.push(`- review: https://openreview.net/forum?id=${ids.openreview} — the paper's OpenReview discussion`);

  return {
    report: lines.length
      ? `Resources for ${key} (code linked in the paper is most likely the official one; repositories listed elsewhere may be unofficial):\n${lines.join("\n")}`
      : `Resources for ${key}: none found (no links in the text read, and none listed on Hugging Face).${text ? "" : " The paper's full text is not available here."}`,
    count: lines.length,
  };
}

// ---------------------------------------------------------------------------
// Reading a resource
// ---------------------------------------------------------------------------

async function getText(url: string, accept = "text/plain, text/markdown, text/html;q=0.9, */*;q=0.5") {
  let res: Response;
  try {
    res = await safeFetch(url, { timeoutMs: 20_000, headers: { ...UA, Accept: accept } });
  } catch (err) {
    throw new ToolInputError(
      err instanceof UnsafeUrlError ? err.message : `${new URL(url).hostname} could not be reached.`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ToolInputError(`${new URL(url).hostname} answered with HTTP ${res.status}.`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (/^(image|video|audio)\/|application\/(pdf|zip|octet-stream)/.test(type)) {
    await res.body?.cancel();
    throw new ToolInputError(`That link is not text (${type.split(";")[0]}).`);
  }
  const body = new TextDecoder().decode(await readLimited(res, MAX_BYTES).catch(() => new Uint8Array()));
  return { body, html: type.includes("html") || /^\s*<(!doctype|html)/i.test(body) };
}

/** Visible text of an HTML page (scripts, styles and markup removed). */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const shorten = (t: string) =>
  t.length > TEXT_SHOWN ? `${t.slice(0, TEXT_SHOWN)}\n… (cut at ${TEXT_SHOWN} characters)` : t;

interface GithubRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  archived: boolean;
  default_branch: string;
  license: { spdx_id: string } | null;
}

/**
 * Reads a resource: a GitHub repository (overview, README and top-level files, or one file with "path"),
 * a Hugging Face model or dataset card, or any web page as text.
 */
export async function readResource(_ctx: ToolContext, input: { url: string; path?: string }): Promise<ToolResult> {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    throw new ToolInputError("That is not a valid URL.");
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "github.com" && parts.length >= 2) {
    const [owner, repo] = [parts[0], parts[1].replace(/\.git$/, "")];
    // A file: from "path", or a /blob/<branch>/<path> link.
    const filePath = input.path?.replace(/^\/+/, "") ?? (parts[2] === "blob" ? parts.slice(4).join("/") : "");
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    if (filePath) {
      const { body } = await getText(
        `${api}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`,
        "application/vnd.github.raw",
      );
      return { report: `${owner}/${repo}: ${filePath}\n${shorten(body)}` };
    }
    const meta = await getJson<GithubRepo>(api);
    if (!meta)
      throw new ToolInputError(
        `GitHub did not return ${owner}/${repo} (it may not exist, or the hourly limit was reached).`,
      );
    const [readme, files] = await Promise.all([
      getText(`${api}/readme`, "application/vnd.github.raw").catch(() => ({ body: "", html: false })),
      getJson<{ name: string; type: string }[]>(`${api}/contents`),
    ]);
    const listing = (files ?? []).map((f) => (f.type === "dir" ? `${f.name}/` : f.name)).join(", ");
    return {
      report: [
        `GitHub ${meta.full_name}${meta.archived ? " (archived)" : ""}: ${meta.description ?? "no description"}`,
        `${meta.stargazers_count.toLocaleString("en-US")} stars · last push ${meta.pushed_at.slice(0, 10)} · license ${meta.license?.spdx_id ?? "none stated"}`,
        `Top-level files: ${listing || "(unknown)"} — read one with "path" (e.g. requirements.txt, a config file).`,
        readme.body ? `README:\n${shorten(readme.body)}` : "No README.",
      ].join("\n"),
    };
  }

  if (host === "huggingface.co" && parts.length >= 2) {
    const repo =
      parts[0] === "datasets" || parts[0] === "spaces" ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/");
    const file = input.path?.replace(/^\/+/, "") || "README.md";
    const { body } = await getText(`https://huggingface.co/${repo}/raw/main/${file}`);
    return { report: `Hugging Face ${repo}: ${file}\n${shorten(body)}` };
  }

  const { body, html } = await getText(u.toString());
  return { report: `${u.toString()}:\n${shorten(html ? htmlToText(body) : body)}` };
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

const FUNCTIONS: Record<string, (...x: number[]) => number> = {
  sqrt: Math.sqrt,
  log: Math.log10,
  ln: Math.log,
  log2: Math.log2,
  exp: Math.exp,
  abs: Math.abs,
  round: Math.round,
  ceil: Math.ceil,
  floor: Math.floor,
  min: Math.min,
  max: Math.max,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/**
 * Evaluates an arithmetic expression: numbers (also 1e9, 1_000 and 4k / 3M / 2G / 1T suffixes), + - * / ^ %,
 * parentheses, and sqrt, log, ln, log2, exp, abs, round, ceil, floor, min, max, pi, e. No variables or code.
 */
export function evaluate(expression: string): number {
  const src = expression.replace(/_/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  let i = 0;
  const peek = () => {
    while (src[i] === " ") i++;
    return src[i];
  };
  const fail = (msg: string): never => {
    throw new ToolInputError(`Cannot calculate “${expression}”: ${msg}.`);
  };
  const number = (): number => {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?([kKMGT](?![a-z]))?/.exec(src.slice(i));
    if (!m) fail(`unexpected “${src.slice(i, i + 8)}”`);
    i += m![0].length;
    const scale = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m![3] as "k"] ?? 1;
    return Number(m![1] + (m![2] ?? "")) * scale;
  };
  const primary = (): number => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = sum();
      if (peek() !== ")") fail("missing “)”");
      i++;
      return v;
    }
    if (c === "-") {
      i++;
      return -power();
    }
    if (c === "+") {
      i++;
      return power();
    }
    const name = /^[a-z][a-z0-9]*/i.exec(src.slice(i))?.[0];
    if (name) {
      i += name.length;
      const lower = name.toLowerCase();
      if (lower in CONSTANTS && peek() !== "(") return CONSTANTS[lower];
      const fn = FUNCTIONS[lower];
      if (!fn) fail(`unknown name “${name}”`);
      if (peek() !== "(") fail(`“${name}” needs parentheses`);
      i++;
      const args = [sum()];
      while (peek() === ",") {
        i++;
        args.push(sum());
      }
      if (peek() !== ")") fail("missing “)”");
      i++;
      return fn(...args);
    }
    return number();
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^" || src.slice(i, i + 2) === "**") {
      i += src[i] === "^" ? 1 : 2;
      return base ** power();
    }
    return base;
  };
  const product = (): number => {
    let v = power();
    for (let c = peek(); c === "*" || c === "/" || c === "%"; c = peek()) {
      if (src.slice(i, i + 2) === "**") break;
      i++;
      const r = power();
      v = c === "*" ? v * r : c === "/" ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    for (let c = peek(); c === "+" || c === "-"; c = peek()) {
      i++;
      v = c === "+" ? v + product() : v - product();
    }
    return v;
  };
  if (!src.trim()) fail("it is empty");
  const value = sum();
  if (peek() !== undefined) fail(`unexpected “${src.slice(i, i + 8)}”`);
  if (!Number.isFinite(value)) fail("the result is not a finite number");
  return value;
}

export function calculate(input: { expression: string; label?: string }): ToolResult {
  const value = evaluate(input.expression);
  const shown =
    Math.abs(value) >= 1e15 || (Math.abs(value) < 1e-4 && value !== 0)
      ? value.toExponential(4)
      : Number(value.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return { report: `${input.label ? `${input.label}: ` : ""}${input.expression} = ${shown}` };
}
