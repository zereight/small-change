import type { Finding, Quote } from "./findings.ts";

/**
 * The first line of a finding's comment. Posting skips a finding whose headline an existing
 * comment already opens with, so running a review twice does not post twice.
 */
export function headline(finding: Finding): string {
  return unblocking(finding, `**${finding.severity}** ${neutralize(finding.title)}`);
}

/** The words the tool puts around the model's text. Another language gets the English ones. */
const LABELS: Record<string, { condition: string; evidence: string }> = {
  english: { condition: "Condition", evidence: "Evidence" },
  korean: { condition: "조건", evidence: "증거" },
};
const labelsOf = (language: string) => LABELS[language.toLowerCase()] ?? (LABELS.english as { condition: string; evidence: string });

/**
 * The comment's Markdown, and nothing else: the grade and title, where in the diff, the condition
 * that triggers it and the code that shows it. The title and the condition are given in each of
 * `languages` (the first is the one the model wrote; the others are its translations, if it gave
 * them). The detail, the grading history and who wrote it stay in the command's output.
 */
export function formatComment(finding: Finding, languages: readonly string[]): string {
  const [first = "English", ...others] = languages;
  const translations = others.flatMap((language) => finding.translations?.find((item) => item.language === language) ?? []);
  const where =
    finding.path === undefined
      ? undefined
      : `\`${finding.path.replace(/`/g, "'")}${finding.line === undefined ? "" : `:${finding.line}`}\``;
  const conditions = [
    finding.condition === undefined ? undefined : `${labelsOf(first).condition}: ${neutralize(finding.condition)}`,
    ...translations.map((item) =>
      item.condition === undefined ? undefined : `${labelsOf(item.language).condition}: ${neutralize(item.condition)}`,
    ),
  ].filter((line): line is string => line !== undefined);
  const evidenceLabel = [...new Set(languages.map((language) => labelsOf(language).evidence))].join(" / ");
  return unblocking(
    finding,
    [
      [headline(finding), ...translations.map((item) => neutralize(item.title))].join("\n"),
      where,
      conditions.length === 0 ? undefined : conditions.join("\n"),
      finding.evidence.length === 0 ? undefined : `${evidenceLabel}:\n${finding.evidence.map(quoteLine).join("\n")}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n"),
  );
}

/**
 * The check counts a comment by matching `\bP[12]\b` anywhere in it, not only in the headline. A
 * P3 or a question whose text names a grade ("this is not a P1") would then block the merge it was
 * lowered to avoid blocking. So in those comments an invisible character goes between the P and
 * the digit: it reads the same and the pattern no longer matches. P1 and P2 comments keep their
 * text, since their headline is what the check is meant to count.
 */
function unblocking(finding: Finding, text: string): string {
  return finding.severity === "P1" || finding.severity === "P2" ? text : text.replace(/\bP([12])\b/g, "P\u200B$1");
}

/** One quote as a Markdown line: `path:line` and the code in a code span, with no way out of it. */
function quoteLine(quote: Quote): string {
  const location =
    quote.path === undefined ? undefined : `${quote.path.replace(/`/g, "'")}${quote.line === undefined ? "" : `:${quote.line}`}`;
  const flat = neutralize(quote.quote.replace(/\s+/g, " ").trim().replace(/`/g, "'"));
  const code = flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
  return `- ${location === undefined ? "" : `\`${location}\` `}\`${code}\``;
}

/**
 * Takes the teeth out of model text that was shaped by an untrusted PR: an @mention would notify
 * someone, and a Markdown image would make the reader's browser request a URL the PR chose, with
 * whatever the model was talked into putting in it.
 */
function neutralize(text: string): string {
  return text.replace(/@(?=[\w{])/g, "@\u200B").replace(/!\[/g, "!\\[");
}
