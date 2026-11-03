export const SEVERITIES = ["P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** A path in the new version of the diff, when the model gave one. */
  path?: string;
  line?: number;
}

export interface ParsedFindings {
  /** The valid findings, most severe first, at most the requested number. */
  findings: Finding[];
  /** Entries of the answer that were not findings. */
  dropped: number;
  /** Valid findings beyond the requested number. */
  omitted: number;
}

export class FindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingsError";
  }
}

const MAX_TITLE = 120;
const MAX_DETAIL = 2000;
const MAX_PATH = 300;

/**
 * Reads the model's answer: a JSON object `{"findings": [...]}` (or a bare array), possibly inside
 * a code fence or after some prose. Entries that are not findings are dropped and counted rather
 * than failing the whole answer.
 */
export function parseFindings(answer: string, maxFindings: number): ParsedFindings {
  const parsed = extractJson(answer);
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (entries === undefined) {
    throw new FindingsError('The answer has no "findings" list');
  }

  const seen = new Set<string>();
  const valid: Finding[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const finding = toFinding(entry);
    if (finding === undefined) {
      dropped++;
      continue;
    }
    const key = JSON.stringify([finding.severity, finding.path, finding.line, finding.title]);
    if (!seen.has(key)) {
      seen.add(key);
      valid.push(finding);
    }
  }
  // Array.prototype.sort is stable, so the model's order holds within a severity.
  valid.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return {
    findings: valid.slice(0, maxFindings),
    dropped,
    omitted: Math.max(0, valid.length - maxFindings),
  };
}

function extractJson(answer: string): unknown {
  const trimmed = answer.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  const braces = trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  for (const candidate of [trimmed, fenced, braces]) {
    if (candidate === undefined || candidate === "") {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  throw new FindingsError(`The answer is not JSON: ${preview || "(empty)"}`);
}

function toFinding(entry: unknown): Finding | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { severity, title, detail, path, line } = entry as Record<string, unknown>;
  const level = typeof severity === "string" ? severity.trim().toUpperCase() : "";
  if (!(SEVERITIES as readonly string[]).includes(level)) {
    return undefined;
  }
  const cleanTitle = typeof title === "string" ? clip(title.replace(/\s+/g, " ").trim(), MAX_TITLE) : "";
  if (cleanTitle === "") {
    return undefined;
  }
  const finding: Finding = {
    severity: level as Severity,
    title: cleanTitle,
    detail: typeof detail === "string" ? clip(detail.trim(), MAX_DETAIL) : "",
  };
  if (typeof path === "string" && path.trim() !== "" && !/[\r\n]/.test(path)) {
    finding.path = clip(path.trim(), MAX_PATH);
  }
  if (typeof line === "number" && Number.isInteger(line) && line > 0 && line < 10_000_000) {
    finding.line = line;
  }
  return finding;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
