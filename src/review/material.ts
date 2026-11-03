import type { ContextFile } from "./context.ts";
import type { DiffFile } from "./diff.ts";

/** Whether `quote` is, word for word, in the material shown for `path` (any path when empty). */
export type QuoteChecker = (path: string | undefined, quote: string) => boolean;

/** A quote shorter than this proves nothing: `}` and `return` are in every file. */
export const MIN_QUOTE_CHARS = 10;

/**
 * What the reviewer was shown, per path: the lines of the diff without their markers, and the
 * code of the expanded files. A quote counts only if it is in that text, with runs of whitespace
 * treated as one, so a quote cannot be made up or taken from code that was not shown.
 */
export function buildQuoteChecker(diffFiles: readonly DiffFile[], contextFiles: readonly ContextFile[]): QuoteChecker {
  const byPath = new Map<string, string[]>();
  const add = (path: string, text: string) => {
    byPath.set(path, [...(byPath.get(path) ?? []), text]);
  };
  for (const file of diffFiles) {
    add(file.path, file.text);
  }
  for (const file of contextFiles) {
    add(file.path, file.shown);
  }
  const haystacks = new Map([...byPath].map(([path, texts]) => [path, collapse(texts.join("\n"))]));

  return (path, quote) => {
    const needles = [collapse(quote), collapse(stripMarkers(quote))].filter((needle) => needle.length >= MIN_QUOTE_CHARS);
    if (needles.length === 0) {
      return false;
    }
    const candidates = path === undefined || path.trim() === "" ? [...haystacks.values()] : lookup(haystacks, path);
    return candidates.some((haystack) => needles.some((needle) => haystack.includes(needle)));
  };
}

/** The text for a path as the model wrote it: as is, then without a `a/`, `b/` or `./` prefix. */
function lookup(haystacks: Map<string, string>, path: string): string[] {
  const clean = path.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  for (const variant of [clean, clean.replace(/^[ab]\//, ""), clean.replace(/^\.\//, "")]) {
    const found = haystacks.get(variant);
    if (found !== undefined) {
      return [found];
    }
  }
  return [];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** A quote copied from a diff may still carry each line's `+` or `-`. */
const stripMarkers = (text: string) => text.replace(/^[+-]/gm, "");
