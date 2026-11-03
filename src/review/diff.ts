export interface DiffHunk {
  /** First line of the hunk in the new version of the file. */
  newStart: number;
  /** How many lines the hunk covers in the new version. */
  newLines: number;
}

export interface DiffFile {
  /** The path in the new version, or the old path for a deleted file. */
  path: string;
  /** The whole file is new: its diff already shows all of it. */
  added: boolean;
  deleted: boolean;
  binary: boolean;
  hunks: DiffHunk[];
  /** The lines of the hunks without their `+`, `-` or space marker, joined by newlines. */
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Splits a unified diff (git format, as Bitbucket prints it) into files and hunks. Lines that
 * are not part of a recognizable file are ignored, so a diff that is not in this format gives
 * an empty list instead of an error.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let body: string[] = [];
  let inHunk = false;
  let oldPath: string | undefined;

  const finish = () => {
    if (file !== undefined) {
      file.text = body.join("\n");
      files.push(file);
    }
    file = undefined;
    body = [];
    inHunk = false;
    oldPath = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      file = { path: pathFromHeader(line), added: false, deleted: false, binary: false, hunks: [], text: "" };
      continue;
    }
    if (file === undefined) {
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHunk = true;
      const [, oldStart, oldLines, newStart, newLines] = hunk;
      const parsed = { newStart: Number(newStart), newLines: newLines === undefined ? 1 : Number(newLines) };
      file.hunks.push(parsed);
      if (file.hunks.length === 1) {
        file.added ||= oldStart === "0" && oldLines === "0";
        file.deleted ||= parsed.newStart === 0 && parsed.newLines === 0;
      }
      continue;
    }
    if (inHunk) {
      if (line.startsWith("\\")) {
        continue; // "\ No newline at end of file"
      }
      const marker = line[0];
      if (marker === "+" || marker === "-" || marker === " ") {
        body.push(line.slice(1));
      } else if (line === "") {
        body.push("");
      }
      continue;
    }
    // Header lines before the first hunk.
    if (line.startsWith("new file mode")) {
      file.added = true;
    } else if (line.startsWith("deleted file mode")) {
      file.deleted = true;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      oldPath = headerPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const newPath = headerPath(line.slice(4));
      file.path = newPath ?? oldPath ?? file.path;
    }
  }
  finish();
  // A trailing empty line of the diff is not part of any hunk.
  return files.map((entry) => ({ ...entry, text: entry.text.replace(/\n+$/, "") }));
}

/** `a/x b/y` from `diff --git a/x b/y`; for a path with spaces the halves may be wrong, and the
 * `---`/`+++` lines then correct it. */
function pathFromHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const match = /^a\/(.+) b\/(.+)$/.exec(rest);
  return match?.[2] ?? rest;
}

/** The path of a `---` or `+++` line, or undefined for `/dev/null`. */
function headerPath(value: string): string | undefined {
  const path = value.split("\t")[0]?.trim();
  if (path === undefined || path === "" || path === "/dev/null") {
    return undefined;
  }
  return path.replace(/^[ab]\//, "");
}
