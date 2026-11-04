import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canRun, stderrTail } from "../llm/exec.ts";
import type { Exec } from "../llm/types.ts";
import type { Checkout } from "./checkout.ts";
import {
  type CallersNeed,
  clipLine,
  compose,
  type Entry,
  failure,
  type GrepNeed,
  LIMITS,
  type LookupPool,
  type LookupResult,
  matchesGlob,
  type Need,
  type NeedKind,
  type SkeletonNeed,
} from "./lookup.ts";

export const SEARCH_IDS = ["git-grep", "tgrep", "graft"] as const;
export type SearchId = (typeof SEARCH_IDS)[number];

export function isSearchId(value: string): value is SearchId {
  return (SEARCH_IDS as readonly string[]).includes(value);
}

/** One line of code that a search found. */
export interface Hit {
  path: string;
  line: number;
  text: string;
  /** The function, class or method the line is in, when the engine knows. */
  symbol?: string;
}

export interface EngineContext {
  exec: Exec;
  checkout: Checkout;
  /** Only `PATH`: the engines never see a credential. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** A way to search the PR's code. The agent never runs one: this tool does, on the agent's request. */
export interface SearchEngine {
  id: SearchId;
  label: string;
  /** What it needs on PATH, as an error message names it: a program, and its version when that matters. */
  needs: string;
  /** Whether it reads files from a working tree; else the commit fetched into the checkout is enough. */
  worktree: boolean;
  /** What it can answer. Reading a file is always possible, through git. */
  kinds: readonly NeedKind[];
  isAvailable(exec: Exec): Promise<boolean>;
  /** Setup that takes time and is done once per checkout, such as building an index. */
  prepare(context: EngineContext, timeoutMs: number): Promise<void>;
  grep(context: EngineContext, need: GrepNeed): Promise<Hit[]>;
  callers?(context: EngineContext, need: CallersNeed): Promise<Entry[]>;
  skeleton?(context: EngineContext, need: SkeletonNeed): Promise<Entry[]>;
}

/** Runs one request on an engine and returns what to show the agent. Never throws: a request that
 * fails is an answer that says so, so one bad request does not cost the agent the others. */
export async function runNeed(
  engine: SearchEngine,
  context: EngineContext,
  need: Need,
  pool: LookupPool,
): Promise<LookupResult> {
  const maxChars = Math.min(LIMITS.maxResultChars, pool.remaining());
  if (maxChars <= 0) {
    return failure(need, "the size limit for the lookups of this review was reached");
  }
  try {
    switch (need.kind) {
      case "grep": {
        const hits = (await engine.grep(context, need)).filter((hit) => need.glob === undefined || matchesGlob(need.glob, hit.path));
        return compose(need, hits.map(hitEntry), { maxChars });
      }
      case "file":
        return await readLines(context, need, maxChars);
      case "callers":
        return engine.callers === undefined
          ? failure(need, `${engine.label} cannot answer this kind of request`)
          : compose(need, await engine.callers(context, need), { maxChars });
      case "skeleton":
        return engine.skeleton === undefined
          ? failure(need, `${engine.label} cannot answer this kind of request`)
          : compose(need, await engine.skeleton(context, need), { maxChars });
    }
  } catch (error) {
    return failure(need, oneLine(error instanceof Error ? error.message : String(error)));
  }
}

function hitEntry(hit: Hit): Entry {
  const text = clipLine(hit.text);
  return {
    text: `${hit.path}:${hit.line}| ${text}${hit.symbol === undefined ? "" : `   [in ${hit.symbol}]`}`,
    seen: { path: hit.path, text },
  };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

/** Reading a file, the same for every engine: through git, so a link in the PR cannot lead out. */
const MAX_FILE_BYTES = 1_000_000;

function gitEnv(context: EngineContext): NodeJS.ProcessEnv {
  return { ...context.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

async function readLines(
  context: EngineContext,
  need: Extract<Need, { kind: "file" }>,
  maxChars: number,
): Promise<LookupResult> {
  const { checkout } = context;
  const object = `${checkout.commit}:${need.path}`;
  const options = { cwd: checkout.dir, env: gitEnv(context), timeoutMs: context.timeoutMs };
  const size = await context.exec("git", ["cat-file", "-s", object], options);
  if (size.code !== 0) {
    return failure(need, "no such file at the commit under review");
  }
  if (Number(size.stdout.trim()) > MAX_FILE_BYTES) {
    return failure(need, "the file is larger than 1 MB");
  }
  const blob = await context.exec("git", ["cat-file", "blob", object], options);
  if (blob.code !== 0) {
    return failure(need, "it is not a file");
  }
  if (blob.stdout.includes("\0")) {
    return failure(need, "it is a binary file");
  }
  const lines = blob.stdout.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (need.from > lines.length) {
    return failure(need, `the file has only ${lines.length} lines`);
  }
  const last = Math.min(need.to, lines.length);
  const width = String(last).length;
  const entries: Entry[] = [];
  for (let number = need.from; number <= last; number++) {
    const text = clipLine((lines[number - 1] ?? "").replace(/\r$/, ""));
    entries.push({ text: `${String(number).padStart(width)}| ${text}`, seen: { path: need.path, text } });
  }
  return compose(need, entries, {
    maxChars,
    maxEntries: LIMITS.maxFileLines,
    note: last < need.to ? `the file ends at line ${lines.length}` : `the file has ${lines.length} lines`,
  });
}

// ---------------------------------------------------------------------------------------------
// git grep: searches the tree of the fetched commit, so nothing needs to be checked out.

/** Reads `git grep -n -z` output: `<commit>:<path> NUL <line> NUL <text>`, one match per line. */
export function parseGitGrep(stdout: string, commit: string): Hit[] {
  const prefix = `${commit}:`;
  const hits: Hit[] = [];
  for (const record of stdout.split("\n")) {
    const first = record.indexOf("\0");
    const second = record.indexOf("\0", first + 1);
    if (first < 0 || second < 0) {
      continue;
    }
    const path = record.slice(0, first);
    const line = Number(record.slice(first + 1, second));
    if (Number.isInteger(line) && line > 0) {
      hits.push({ path: path.startsWith(prefix) ? path.slice(prefix.length) : path, line, text: record.slice(second + 1) });
    }
  }
  return hits;
}

export const gitGrep: SearchEngine = {
  id: "git-grep",
  label: "git grep",
  needs: "`git`",
  worktree: false,
  kinds: ["grep", "file"],
  isAvailable: (exec) => canRun(exec, "git"),
  async prepare() {},
  async grep(context, need) {
    const { checkout } = context;
    const args = [
      "grep",
      "-n",
      "-I",
      "-z",
      "--no-color",
      ...(need.ignoreCase ? ["-i"] : []),
      need.regex ? "-E" : "-F",
      "-e",
      need.pattern,
      checkout.commit,
      "--",
    ];
    const result = await context.exec("git", args, { cwd: checkout.dir, env: gitEnv(context), timeoutMs: context.timeoutMs });
    if (result.code === 1) {
      return [];
    }
    if (result.code !== 0) {
      throw new Error(stderrTail(result.stderr, 2) || `git grep exited with code ${result.code}`);
    }
    return parseGitGrep(result.stdout, checkout.commit);
  },
};

// ---------------------------------------------------------------------------------------------
// tgrep: a trigram index over the working tree (https://github.com/microsoft/tgrep).

const tgrepBinary = () => process.env.SMALL_CHANGE_TGREP || "tgrep";

/**
 * The oldest tgrep this tool trusts. 1.2.6 was tried; in 1.0.8 a search with `--hidden` skipped the
 * index, so it would not work as it does here, and versions in between were not tried.
 */
const MIN_TGREP = [1, 2, 6] as const;

/** `1.2.6` from `tgrep 1.2.6`, or undefined. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function olderThan(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    const difference = (version[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

/** Reads `tgrep --json` output (ripgrep's format): one JSON object per line, `match` ones are hits. */
export function parseTgrepJson(stdout: string): Hit[] {
  const hits: Hit[] = [];
  for (const record of stdout.split("\n")) {
    if (!record.startsWith("{")) {
      continue;
    }
    let value: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      value = JSON.parse(record);
    } catch {
      continue;
    }
    const path = value.data?.path?.text?.replace(/^\.\//, "");
    const line = value.data?.line_number;
    const text = value.data?.lines?.text;
    if (value.type !== "match" || path === undefined || typeof line !== "number" || typeof text !== "string") {
      continue;
    }
    if (path === ".git" || path.startsWith(".git/") || path.startsWith(".tgrep/")) {
      continue;
    }
    hits.push({ path, line, text: text.replace(/\r?\n$/, "") });
  }
  // The search runs in parallel, so the order is not stable; the hits are sorted for a reader.
  return hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

async function scratchHome(checkout: Checkout): Promise<string> {
  const home = join(checkout.scratch, "home");
  await mkdir(home, { recursive: true });
  return home;
}

export const tgrep: SearchEngine = {
  id: "tgrep",
  label: "tgrep",
  needs: `\`tgrep\` ${MIN_TGREP.join(".")} or newer`,
  worktree: true,
  kinds: ["grep", "file"],
  async isAvailable(exec) {
    try {
      const result = await exec(tgrepBinary(), ["--version"], { timeoutMs: 15_000 });
      const version = result.code === 0 ? parseVersion(result.stdout) : undefined;
      return version !== undefined && !olderThan(version, MIN_TGREP);
    } catch {
      return false;
    }
  },
  async prepare(context, timeoutMs) {
    const { checkout } = context;
    const env = { ...context.env, HOME: await scratchHome(checkout) };
    // --hidden and --no-ignore: by default the index leaves out dot files (`.eslintrc.js`,
    // `.github/...`) and files that .gitignore matches, such as a tracked `dist/` or `.env.local`.
    // All of them are tracked code, and a search that misses one answers "not found".
    const built = await context.exec(tgrepBinary(), ["--no-config", "index", "--force", "--hidden", "--no-ignore", checkout.dir], { cwd: checkout.dir, env, timeoutMs });
    if (built.code !== 0) {
      throw new Error(`tgrep index failed: ${stderrTail(built.stderr, 2) || `exit code ${built.code}`}`);
    }
    // An index that holds no files makes every search answer "nothing found", which reads as an
    // answer. It was seen once on a fresh checkout and not reproduced, so it is checked every time.
    const status = await context.exec(tgrepBinary(), ["--no-config", "status", checkout.dir], { cwd: checkout.dir, env, timeoutMs });
    const files = Number(/Files:\s+(\d+)/.exec(status.stdout)?.[1] ?? 0);
    if (files === 0) {
      throw new Error("the tgrep index holds no files");
    }
  },
  async grep(context, need) {
    const { checkout } = context;
    const env = { ...context.env, HOME: await scratchHome(checkout) };
    const args = [
      "--no-config",
      "--json",
      // Dot files are in the index but a search leaves them out unless it asks. This is the only
      // flag to pass: `--no-ignore` and `-g` make tgrep skip the index and scan the tree, which is
      // many times slower. (In tgrep 1.0.8 `--hidden` skipped the index too, hence MIN_TGREP.)
      "--hidden",
      ...(need.ignoreCase ? ["-i"] : []),
      ...(need.regex ? [] : ["-F"]),
      "-e",
      need.pattern,
      "--",
      ".",
    ];
    const result = await context.exec(tgrepBinary(), args, { cwd: checkout.dir, env, timeoutMs: context.timeoutMs });
    if (result.code === 1) {
      return [];
    }
    if (result.code !== 0) {
      throw new Error(stderrTail(result.stderr, 2) || `tgrep exited with code ${result.code}`);
    }
    return parseTgrepJson(result.stdout);
  },
};

// ---------------------------------------------------------------------------------------------
// graft: a structural graph of the code (https://github.com/trailhq/Trail-Code), built with
// tree-sitter on this machine.

const graftBinary = () => process.env.SMALL_CHANGE_GRAFT || "graft";

/** `graft grep --json`: hits grouped by the symbol they are in, the most connected symbols first. */
export function parseGraftGrep(stdout: string): Hit[] {
  const value = JSON.parse(stdout) as {
    groups?: { symbol?: string | null; path?: string; hits?: { line?: number; text?: string }[] }[];
  };
  const hits: Hit[] = [];
  for (const group of value.groups ?? []) {
    for (const hit of group.hits ?? []) {
      if (typeof group.path === "string" && typeof hit.line === "number" && typeof hit.text === "string") {
        hits.push({ path: group.path, line: hit.line, text: hit.text, ...(typeof group.symbol === "string" ? { symbol: group.symbol } : {}) });
      }
    }
  }
  return hits;
}

/**
 * `graft callers` prints, for each symbol that matches the name, the symbols that call it and the
 * lines of the calls. Its output also carries a line that addresses the agent reading it, which
 * is not data about the code and is left out.
 */
export function parseGraftCallers(stdout: string): Entry[] {
  const entries: Entry[] = [];
  let path: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("[graft]")) {
      continue;
    }
    const caller = /^\s+(\w+) ← (.+) \((.+?):L\d+(?:-L\d+)?\)$/.exec(line);
    const site = /^\s+(\d+): (.*)$/.exec(line);
    if (caller !== null) {
      path = caller[3];
      entries.push({ text: `${caller[1] ?? ""} ← ${caller[2] ?? ""} (${caller[3] ?? ""})` });
    } else if (site !== null && path !== undefined) {
      const text = clipLine(site[2] ?? "");
      entries.push({ text: `${path}:${site[1] ?? ""}| ${text}`, seen: { path, text } });
    } else if (!line.startsWith(" ")) {
      path = undefined;
      entries.push({ text: line });
    }
  }
  return entries;
}

export function parseGraftSkeleton(stdout: string): Entry[] {
  const value = JSON.parse(stdout) as { file?: string; entries?: { name?: string; kind?: string; span?: string; signature?: string }[] };
  const path = value.file;
  return (value.entries ?? []).flatMap((entry) => {
    if (typeof path !== "string" || typeof entry.signature !== "string") {
      return [];
    }
    const signature = clipLine(entry.signature.replace(/\s+/g, " "));
    return [{ text: `${entry.span ?? ""}  ${entry.kind ?? ""} ${entry.name ?? ""}: ${signature}`, seen: { path, text: signature } }];
  });
}

async function graftEnv(context: EngineContext): Promise<NodeJS.ProcessEnv> {
  // Telemetry stays off (it would report a build of the PR's repository), and nothing is written
  // to the user's home.
  return { ...context.env, HOME: await scratchHome(context.checkout), DO_NOT_TRACK: "1" };
}

async function graft(context: EngineContext, args: string[], timeoutMs: number): Promise<string> {
  const { checkout } = context;
  const result = await context.exec(graftBinary(), args, { cwd: checkout.dir, env: await graftEnv(context), timeoutMs });
  if (result.code !== 0) {
    throw new Error(stderrTail(result.stderr || result.stdout, 2) || `graft exited with code ${result.code}`);
  }
  return result.stdout;
}

export const graftEngine: SearchEngine = {
  id: "graft",
  label: "graft",
  needs: "`graft`",
  worktree: true,
  kinds: ["grep", "file", "callers", "skeleton"],
  isAvailable: (exec) => canRun(exec, graftBinary()),
  async prepare(context, timeoutMs) {
    await graft(context, ["build", context.checkout.dir], timeoutMs);
  },
  async grep(context, need) {
    const args = ["grep", "--json", "--no-refresh", ...(need.regex ? [] : ["--fixed"]), ...(need.ignoreCase ? ["-i"] : []), "--", need.pattern, context.checkout.dir];
    return parseGraftGrep(await graft(context, args, context.timeoutMs));
  },
  async callers(context, need) {
    const entries = parseGraftCallers(await graft(context, ["callers", "--no-refresh", "--", need.symbol, context.checkout.dir], context.timeoutMs));
    if (entries.length === 0) {
      throw new Error("no symbol of that name in the graph");
    }
    return entries;
  },
  async skeleton(context, need) {
    return parseGraftSkeleton(await graft(context, ["skeleton", "--json", "--no-refresh", "--", need.path, context.checkout.dir], context.timeoutMs));
  },
};

export const ENGINES: Record<SearchId, SearchEngine> = { "git-grep": gitGrep, tgrep, graft: graftEngine };
