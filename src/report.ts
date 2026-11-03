import type { Report } from "./evaluate.ts";

const LABELS = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;

/** The report as text: one line per check, its details indented below, then the verdict. */
export function formatReport(report: Report): string {
  const { ref, title, author } = report.pullRequest;
  const width = Math.max(...report.results.map((check) => check.name.length));
  const lines = [`${ref.workspace}/${ref.repo}#${ref.id} "${title}" by ${author}`, ""];
  for (const check of report.results) {
    lines.push(`${LABELS[check.status]}  ${check.name.padEnd(width)}  ${check.summary}`);
    for (const detail of check.details) {
      lines.push(`      - ${detail}`);
    }
  }
  lines.push("", report.eligible ? "Result: small change" : "Result: not a small change");
  return lines.join("\n");
}
