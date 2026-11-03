import type { DiffFile } from "./diff.ts";

/** A changed file as the reviewer is shown it: the whole file, or the regions around the hunks. */
export interface ContextFile {
  path: string;
  /** The lines as shown to the reviewer, each prefixed with its line number. */
  numbered: string;
  /** What the reviewer saw, without line numbers: what a quote is checked against. */
  shown: string;
  /** The line ranges shown, as `from-to`; the whole file is one range. */
  ranges: string;
  totalLines: number;
  whole: boolean;
  /** The file had more to show than the limits allowed. */
  truncated: boolean;
  bytes: number;
}

export interface ContextOmission {
  path: string;
  reason: string;
}

export interface ReviewContext {
  files: ContextFile[];
  omitted: ContextOmission[];
  bytes: number;
}

export interface ContextOptions {
  /** Lines shown around each hunk. */
  lines: number;
  /** All files together. Zero turns the expansion off. */
  totalBytes: number;
  /** A file up to this size is shown whole. */
  wholeFileBytes?: number;
  /** One file's share, above which its regions are cut. */
  perFileBytes?: number;
  /** Changed files looked at in one review. */
  maxFiles?: number;
  /** Files read at the same time. */
  concurrency?: number;
}

const DEFAULTS = { wholeFileBytes: 16_000, perFileBytes: 30_000, maxFiles: 30, concurrency: 5 };
const MAX_LINE_CHARS = 400;

const LOCK_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|Podfile\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Package\.resolved)$/;
const GENERATED = /(\.min\.(js|css)|\.map|\.snap|\.pb\.(ts|js|go|swift|kt)|_pb\.(ts|js)|\.generated\.[a-z]+)$|(^|\/)(__generated__|__snapshots__|generated)\//;
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tar|jar|aar|so|a|dylib|xcframework|bin|ttf|otf|woff2?|mp[34]|mov|wav|lottie|db|sqlite)$/i;

/** Why a changed file is not expanded, or undefined when it should be. */
export function skipReason(file: DiffFile): string | undefined {
  if (file.deleted) {
    return "deleted file";
  }
  if (file.binary || BINARY_EXTENSIONS.test(file.path)) {
    return "binary file";
  }
  if (file.hunks.length === 0) {
    return "no textual changes in the diff";
  }
  if (file.added) {
    return "new file: the diff already shows all of it";
  }
  if (LOCK_FILES.test(file.path)) {
    return "lock file";
  }
  if (GENERATED.test(file.path)) {
    return "generated or minified file";
  }
  return undefined;
}

/**
 * Reads the changed files at the PR's source commit and cuts them to what the reviewer needs:
 * the whole file when it is small, else the lines around each hunk. Files that cannot or need not
 * be shown are listed with the reason, so the reviewer never assumes what it was not shown. A
 * file that cannot be read is skipped; it never fails the review.
 */
export async function buildContext(
  diffFiles: readonly DiffFile[],
  read: (path: string) => Promise<string | undefined>,
  options: ContextOptions,
): Promise<ReviewContext> {
  const settings = { ...DEFAULTS, ...options };
  const context: ReviewContext = { files: [], omitted: [], bytes: 0 };
  if (settings.totalBytes <= 0) {
    return context;
  }

  const wanted: DiffFile[] = [];
  for (const file of diffFiles) {
    const reason = skipReason(file);
    if (reason !== undefined) {
      context.omitted.push({ path: file.path, reason });
    } else if (wanted.length >= settings.maxFiles) {
      context.omitted.push({ path: file.path, reason: `more than ${settings.maxFiles} changed files` });
    } else {
      wanted.push(file);
    }
  }

  const texts = await mapLimited(wanted, settings.concurrency, async (file) => {
    try {
      return { text: await read(file.path) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  wanted.forEach((file, index) => {
    const outcome = texts[index];
    if (outcome === undefined || "error" in outcome) {
      context.omitted.push({ path: file.path, reason: `could not be read: ${oneLine(outcome?.error ?? "unknown error")}` });
      return;
    }
    if (outcome.text === undefined) {
      context.omitted.push({ path: file.path, reason: "not found at the source commit" });
      return;
    }
    const shown = render(file, outcome.text, settings);
    if (shown.numbered === "") {
      context.omitted.push({ path: file.path, reason: "its changed regions are larger than the per-file limit" });
      return;
    }
    if (context.bytes + shown.bytes > settings.totalBytes) {
      context.omitted.push({ path: file.path, reason: "context size limit reached" });
      return;
    }
    context.files.push(shown);
    context.bytes += shown.bytes;
  });
  return context;
}

interface RenderSettings {
  lines: number;
  wholeFileBytes: number;
  perFileBytes: number;
}

function render(file: DiffFile, text: string, settings: RenderSettings): ContextFile {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const width = String(lines.length).length;
  const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  const numbered = (from: number, to: number) =>
    lines
      .slice(from - 1, to)
      .map((line, offset) => `${String(from + offset).padStart(width)}| ${clip(line)}`);

  const whole = Buffer.byteLength(text) <= settings.wholeFileBytes;
  const ranges = whole ? [[1, lines.length] as const] : regions(file, lines.length, settings.lines);

  const out: string[] = [];
  const shown: string[] = [];
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const [from, to] of ranges) {
    const chunk = numbered(from, to);
    const size = Buffer.byteLength(chunk.join("\n"));
    if (bytes + size > settings.perFileBytes) {
      truncated = true;
      break;
    }
    if (out.length > 0) {
      out.push("   ...");
    }
    out.push(...chunk);
    shown.push(...lines.slice(from - 1, to).map(clip));
    kept.push(`${from}-${to}`);
    bytes += size;
  }
  return {
    path: file.path,
    numbered: out.join("\n"),
    shown: shown.join("\n"),
    ranges: kept.join(", "),
    totalLines: lines.length,
    whole: whole && !truncated,
    truncated,
    bytes,
  };
}

/** The line ranges around the hunks, widened by `lines` and merged where they touch. */
function regions(file: DiffFile, total: number, lines: number): [number, number][] {
  const wanted = file.hunks
    .map((hunk): [number, number] => [
      Math.max(1, hunk.newStart - lines),
      Math.min(total, hunk.newStart + Math.max(hunk.newLines, 1) - 1 + lines),
    ])
    .filter(([from, to]) => from <= to)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of wanted) {
    const last = merged.at(-1);
    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/** Runs `work` on every item, at most `limit` at a time, keeping the order of the results. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
