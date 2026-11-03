import type { Finding } from "./findings.ts";

/**
 * The first line of a finding's comment. Posting skips a finding whose headline an existing
 * comment already opens with, so running a review twice does not post twice.
 */
export function headline(finding: Finding): string {
  return `**${finding.severity}** ${neutralize(finding.title)}`;
}

/** The comment's Markdown: the headline, where in the diff, the detail, and who wrote it. */
export function formatComment(finding: Finding, footer: string): string {
  const where =
    finding.path === undefined
      ? undefined
      : `\`${finding.path.replace(/`/g, "'")}${finding.line === undefined ? "" : `:${finding.line}`}\``;
  return [
    headline(finding),
    where,
    finding.detail === "" ? undefined : neutralize(finding.detail),
    `_${footer}_`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

/**
 * Takes the teeth out of model text that was shaped by an untrusted PR: an @mention would notify
 * someone, and a Markdown image would make the reader's browser request a URL the PR chose, with
 * whatever the model was talked into putting in it.
 */
function neutralize(text: string): string {
  return text.replace(/@(?=[\w{])/g, "@\u200B").replace(/!\[/g, "!\\[");
}
