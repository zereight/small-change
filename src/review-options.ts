import { parseArgs } from "node:util";
import { type PullRequestRef, parsePullRequestUrl } from "./pr-url.ts";
import { UsageError } from "./options.ts";
import type { ReviewOptions } from "./review/review.ts";

export const REVIEW_USAGE = `Usage: small-change review <PR URL> [options]

Has the agent chosen with "small-change model setup" review the pull request's diff and prints
its findings, graded P1 (must fix), P2 (should fix) and P3 (minor). With --post, each finding is
also posted as a comment, which the "small-change <PR URL>" check can then count.

Arguments:
  <PR URL>                 https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>

Options:
  --post                   Post each finding as a comment on the pull request
                           (needs BITBUCKET_TOKEN with write access to pull requests)
  --language <name>        The language of the findings (default: English)
  --max-findings <n>       Report at most n findings (default: 10)
  --max-diff-bytes <n>     Refuse a diff larger than n bytes (default: 300000)
  --timeout <seconds>      Give the agent this long (default: 900)
  --config <file>          Read the model choice from this file instead of the default
  -h, --help               Show this help and exit

The agent runs in an empty directory with its tools off and without any BITBUCKET_ variable,
and the pull request's text is handed to it as data to review, not as instructions.

Environment:
  BITBUCKET_TOKEN          An access token for private repositories; with --post, also for writing`;

export type ReviewCommand =
  | { command: "help" }
  | { command: "review"; ref: PullRequestRef; options: ReviewOptions; config: string | undefined };

/** Parses the arguments after `review`. Throws {@link UsageError}. */
export function parseReviewArgs(argv: string[]): ReviewCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return { command: "help" };
  }
  const [url, ...extra] = positionals;
  if (url === undefined) {
    throw new UsageError("Missing required argument: <PR URL>");
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected extra arguments: ${extra.join(" ")}`);
  }
  const ref = parsePullRequestUrl(url);
  if (ref === undefined) {
    throw new UsageError(
      `Invalid PR URL: "${url}". Expected https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`,
    );
  }
  const language = values.language?.trim();
  if (language !== undefined && (language === "" || /[\r\n]/.test(language) || language.length > 40)) {
    throw new UsageError(`Invalid --language "${values.language}": expected a short language name`);
  }
  return {
    command: "review",
    ref,
    config: values.config,
    options: {
      post: values.post ?? false,
      language: language ?? "English",
      maxFindings: positive(values["max-findings"], "--max-findings") ?? 10,
      maxDiffBytes: positive(values["max-diff-bytes"], "--max-diff-bytes") ?? 300_000,
      timeoutMs: (positive(values.timeout, "--timeout") ?? 900) * 1000,
    },
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      post: { type: "boolean" },
      language: { type: "string" },
      "max-findings": { type: "string" },
      "max-diff-bytes": { type: "string" },
      timeout: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new UsageError(`Invalid ${flag} "${value}": expected a positive integer`);
  }
  return number;
}
