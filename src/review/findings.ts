import type { QuoteChecker } from "./material.ts";

/**
 * P1 and P2 are the grades the `small-change` check counts, so they are the only ones that need
 * proof. P3 is minor, or a gap whose trigger is not shown. ASK is a question to the author.
 */
export const SEVERITIES = ["P1", "P2", "P3", "ASK"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * What a finding rests on. `code`: the quoted code alone shows the defect. `event`: it also needs
 * something to happen at run time (a throw, a false return, a destroyed screen). `contract`: it
 * depends on a server contract or on code that was not shown.
 */
export const BASES = ["code", "event", "contract"] as const;
export type Basis = (typeof BASES)[number];

export interface Quote {
  path?: string;
  line?: number;
  quote: string;
}

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  basis: Basis;
  /** The exact input or state sequence that triggers the defect. */
  condition?: string;
  /** Where the defect is, in the new version of the file. */
  path?: string;
  line?: number;
  /** Quotes that were found in the material shown. Quotes that were not are dropped. */
  evidence: Quote[];
  /** For `event`: the quote that shows the event happening. */
  firing?: Quote;
  /** Set when the grade was lowered because the finding was not proven. */
  lowered?: { from: Severity; reason: string };
}

export interface ParsedFindings {
  /** The valid findings after grading, most severe first, at most the requested number. */
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
const MAX_CONDITION = 500;
const MAX_PATH = 300;
const MAX_QUOTE = 1000;
const MAX_QUOTES = 3;

/**
 * Reads the model's answer: a JSON object `{"findings": [...]}` (or a bare array), possibly inside
 * a code fence or after some prose. Entries that are not findings are dropped and counted rather
 * than failing the whole answer. A P1 or P2 that is not proven is lowered, never kept as it was.
 */
export function parseFindings(answer: string, maxFindings: number, check: QuoteChecker): ParsedFindings {
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
      valid.push(grade(finding, check));
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

/**
 * Keeps only the quotes that exist in the material shown, and lowers a P1 or P2 that lacks proof:
 * a contract-dependent one becomes a question, any other becomes a P3. The first missing proof
 * is the reason given.
 */
function grade(finding: Finding, check: QuoteChecker): Finding {
  const evidence = finding.evidence.filter((quote) => check(quote.path ?? finding.path, quote.quote));
  const firing =
    finding.firing !== undefined && check(finding.firing.path ?? finding.path, finding.firing.quote)
      ? finding.firing
      : undefined;
  const { firing: _unchecked, evidence: _all, ...rest } = finding;
  const graded: Finding = { ...rest, evidence, ...(firing === undefined ? {} : { firing }) };

  if (finding.severity !== "P1" && finding.severity !== "P2") {
    return graded;
  }
  const verdict = missingProof(finding, evidence.length, firing !== undefined);
  return verdict === undefined
    ? graded
    : { ...graded, severity: verdict.to, lowered: { from: finding.severity, reason: verdict.reason } };
}

function missingProof(
  finding: Finding,
  verifiedEvidence: number,
  firingVerified: boolean,
): { to: Severity; reason: string } | undefined {
  if (finding.basis === "contract") {
    return { to: "ASK", reason: "it depends on a contract or on code that was not shown, so it is a question" };
  }
  if (finding.condition === undefined) {
    return { to: "P3", reason: "no trigger condition was given" };
  }
  if (verifiedEvidence === 0) {
    return {
      to: "P3",
      reason: finding.evidence.length === 0 ? "no evidence quote was given" : "no evidence quote was found in the code shown",
    };
  }
  if (finding.basis === "event" && !firingVerified) {
    return {
      to: "P3",
      reason:
        finding.firing === undefined
          ? "it needs a run-time event, and no quote shows the event happening"
          : "the quote that should show the event was not found in the code shown",
    };
  }
  return undefined;
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
  const { severity, title, detail, path, line, basis, condition, evidence, firing } = entry as Record<string, unknown>;
  const level = typeof severity === "string" ? severity.trim().toUpperCase() : "";
  if (!(SEVERITIES as readonly string[]).includes(level)) {
    return undefined;
  }
  const cleanTitle = typeof title === "string" ? clip(title.replace(/\s+/g, " ").trim(), MAX_TITLE) : "";
  if (cleanTitle === "") {
    return undefined;
  }
  const cleanPath = typeof path === "string" && path.trim() !== "" && !/[\r\n]/.test(path) ? clip(path.trim(), MAX_PATH) : undefined;
  const kind = typeof basis === "string" ? basis.trim().toLowerCase() : "code";
  const finding: Finding = {
    severity: level as Severity,
    title: cleanTitle,
    detail: typeof detail === "string" ? clip(detail.trim(), MAX_DETAIL) : "",
    basis: (BASES as readonly string[]).includes(kind) ? (kind as Basis) : "code",
    evidence: (Array.isArray(evidence) ? evidence : [])
      .map((value) => toQuote(value, cleanPath))
      .filter((quote): quote is Quote => quote !== undefined)
      .slice(0, MAX_QUOTES),
  };
  if (cleanPath !== undefined) {
    finding.path = cleanPath;
  }
  if (typeof line === "number" && Number.isInteger(line) && line > 0 && line < 10_000_000) {
    finding.line = line;
  }
  if (typeof condition === "string" && condition.trim() !== "") {
    finding.condition = clip(condition.trim(), MAX_CONDITION);
  }
  const firingQuote = toQuote(firing, cleanPath);
  if (firingQuote !== undefined) {
    finding.firing = firingQuote;
  }
  return finding;
}

/** A quote is an object with a `quote`, or a bare string standing for a quote in the finding's file. */
function toQuote(value: unknown, fallbackPath: string | undefined): Quote | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : { ...(fallbackPath === undefined ? {} : { path: fallbackPath }), quote: clip(value, MAX_QUOTE) };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { path, line, quote } = value as Record<string, unknown>;
  if (typeof quote !== "string" || quote.trim() === "") {
    return undefined;
  }
  const where = typeof path === "string" && path.trim() !== "" && !/[\r\n]/.test(path) ? clip(path.trim(), MAX_PATH) : fallbackPath;
  return {
    ...(where === undefined ? {} : { path: where }),
    ...(typeof line === "number" && Number.isInteger(line) && line > 0 ? { line } : {}),
    quote: clip(quote, MAX_QUOTE),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
