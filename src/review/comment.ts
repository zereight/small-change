import type { Finding, Quote } from "./findings.ts";

/**
 * The first line of a finding's comment. Posting skips a finding whose headline an existing
 * comment already opens with, so running a review twice does not post twice.
 */
export function headline(finding: Finding): string {
  return unblocking(finding, `**${finding.severity}** ${neutralize(finding.title)}`);
}

/**
 * The comment's Markdown: the headline, where in the diff, the detail, the condition and the
 * evidence that back it, why it was graded lower than the model first said (and the quote the
 * second reviewer used, if it refuted the finding), and who wrote it.
 */
export function formatComment(finding: Finding, footer: string): string {
  return unblocking(finding, comment(finding, footer));
}

function comment(finding: Finding, footer: string): string {
  const where =
    finding.path === undefined
      ? undefined
      : `\`${finding.path.replace(/`/g, "'")}${finding.line === undefined ? "" : `:${finding.line}`}\``;
  return [
    headline(finding),
    where,
    finding.detail === "" ? undefined : neutralize(finding.detail),
    finding.condition === undefined ? undefined : `Condition: ${neutralize(finding.condition)}`,
    finding.evidence.length === 0 ? undefined : `Evidence:\n${finding.evidence.map(quoteLine).join("\n")}`,
    finding.firing === undefined ? undefined : `Firing:\n${quoteLine(finding.firing)}`,
    finding.lowered === undefined
      ? undefined
      : `_Graded ${finding.severity}, not ${finding.lowered.from}: ${neutralize(finding.lowered.reason)}._`,
    finding.counter === undefined ? undefined : `Against it:\n${quoteLine(finding.counter)}`,
    `_${footer}_`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

/**
 * The check counts a comment by matching `\bP[12]\b` anywhere in it, not only in the headline. A
 * P3 or a question that says "Graded P3, not P1", or whose text mentions a P2, would then block the
 * merge it was lowered to avoid blocking. So in those comments an invisible character goes between
 * the P and the digit: it reads the same and the pattern no longer matches. P1 and P2 comments keep
 * their text, since their headline is what the check is meant to count.
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
