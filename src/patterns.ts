/** The name of the file, at the repository root, that lists the paths a small change must not touch. */
export const EXCLUSION_FILE = ".small_change";

export interface PathMatcher {
  /** The patterns this matcher was built from, in file order. */
  readonly patterns: readonly string[];
  /** The first pattern that matches `path` (a `/`-separated path from the repository root). */
  match(path: string): string | undefined;
}

export const NO_EXCLUSIONS: PathMatcher = { patterns: [], match: () => undefined };

/**
 * Parses the text of an exclusion file. One pattern per line, with the core of `.gitignore`'s
 * syntax: `#` starts a comment, a trailing `/` matches directories only, a leading or inner `/`
 * anchors the pattern to the repository root, `*` and `?` stay within one path segment, and `**`
 * crosses segments. A pattern that names a directory covers everything under it. Negation (`!`) is
 * refused rather than guessed at, because ignoring it would silently widen what counts as small.
 */
export function parseExclusions(text: string): PathMatcher {
  const compiled: { pattern: string; regex: RegExp }[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const pattern = rawLine.trim();
    if (pattern === "" || pattern.startsWith("#")) {
      continue;
    }
    if (pattern.startsWith("!")) {
      throw new Error(`${EXCLUSION_FILE} line ${index + 1}: negation ("!") is not supported`);
    }
    compiled.push({ pattern, regex: compile(pattern, index + 1) });
  }
  return {
    patterns: compiled.map((entry) => entry.pattern),
    match: (path) => compiled.find((entry) => entry.regex.test(path))?.pattern,
  };
}

function compile(pattern: string, lineNumber: number): RegExp {
  const directoryOnly = pattern.endsWith("/");
  let body = directoryOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes("/");
  if (body.startsWith("/")) {
    body = body.slice(1);
  }
  if (body === "") {
    throw new Error(`${EXCLUSION_FILE} line ${lineNumber}: the pattern names no path`);
  }

  let source = "";
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i);
    if (char === "*" && body.charAt(i + 1) === "*") {
      const startsSegment = i === 0 || body.charAt(i - 1) === "/";
      const next = body.charAt(i + 2);
      if (startsSegment && next === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else if (startsSegment && next === "") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }

  const start = anchored ? "^" : "^(?:.*/)?";
  const end = directoryOnly ? "/.+$" : "(?:/.+)?$";
  return new RegExp(start + source + end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
