import { parseArgs } from "node:util";
import { type PullRequestRef, parsePullRequestUrl } from "./pr-url.ts";
import { UsageError } from "./options.ts";
import { isSearchId, SEARCH_IDS } from "./review/engines.ts";
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
  --language <names>       The languages of the comments, comma separated, at most 3. The first is the one
                           the model writes in and the output uses; the others are translations of each
                           comment's title and condition (default: English,Korean)
  --max-findings <n>       Report at most n findings (default: 10)
  --max-diff-bytes <n>     Review a diff larger than n bytes in parts of at most n bytes, cut between files
                           (default: 300000)
  --max-parts <n>          Review at most n parts; the files after them are listed as not reviewed
                           (default: 6)
  --context-bytes <n>      Show at most n bytes of the changed files' code besides the diff, so that
                           findings can rest on code around the change; 0: the diff only (default: 120000)
  --context-lines <n>      Lines shown around each change in a file too large to show whole (default: 40)
  --search <engine>        Let the agents ask to see more code of the pull request, which this tool then
                           finds on a checkout of its commit: auto, tgrep, git-grep, graft, or off
                           (default: auto, which is tgrep, or git-grep when tgrep is not installed)
  --max-lookups <n>        The most lookups an agent may ask for in a turn (default: 8)
  --json                   Print the result as JSON instead of text
  --no-verifier            Do not have the verifier try to refute the P1 and P2 findings, even if one
                           is configured ("small-change model setup --role verifier")
  --timeout <seconds>      Give each agent this long (default: 900)
  --config <file>          Read the model choice from this file instead of the default
  -h, --help               Show this help and exit

The agents run in an empty directory with their tools off and without any BITBUCKET_ variable,
and the pull request's text is handed to them as data to review, not as instructions.

With a verifier configured, each P1 and P2 is shown to a second model that tries to refute it. A
refutation needs a quote from the code, like the finding itself; the finding is then posted as a P3
with the quote. If the verifier fails, nothing is posted.

Environment:
  BITBUCKET_TOKEN          An access token for private repositories; with --post, also for writing`;

export type ReviewCommand =
  | { command: "help" }
  | { command: "review"; ref: PullRequestRef; options: ReviewOptions; config: string | undefined; json: boolean };

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
  const languages = parseLanguages(values.language);
  const search = values.search ?? "auto";
  if (search !== "off" && search !== "auto" && !isSearchId(search)) {
    throw new UsageError(`Invalid --search "${search}": expected ${[...SEARCH_IDS, "auto", "off"].join(", ")}`);
  }
  return {
    command: "review",
    ref,
    config: values.config,
    json: values.json ?? false,
    options: {
      post: values.post ?? false,
      verifier: values.verifier ?? true,
      search,
      maxLookups: positive(values["max-lookups"], "--max-lookups") ?? 8,
      languages,
      maxFindings: positive(values["max-findings"], "--max-findings") ?? 10,
      maxDiffBytes: positive(values["max-diff-bytes"], "--max-diff-bytes") ?? 300_000,
      maxParts: positive(values["max-parts"], "--max-parts") ?? 6,
      contextBytes: nonNegative(values["context-bytes"], "--context-bytes") ?? 120_000,
      contextLines: positive(values["context-lines"], "--context-lines") ?? 40,
      timeoutMs: (positive(values.timeout, "--timeout") ?? 900) * 1000,
    },
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      post: { type: "boolean" },
      verifier: { type: "boolean" },
      search: { type: "string" },
      "max-lookups": { type: "string" },
      json: { type: "boolean" },
      language: { type: "string" },
      "max-findings": { type: "string" },
      "max-diff-bytes": { type: "string" },
      "max-parts": { type: "string" },
      "context-bytes": { type: "string" },
      "context-lines": { type: "string" },
      timeout: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function nonNegative(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new UsageError(`Invalid ${flag} "${value}": expected a non-negative integer`);
  }
  return number;
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

const MAX_LANGUAGES = 3;

/** `English,Korean` as a list, without repeats (case aside); the default is English then Korean. */
function parseLanguages(value: string | undefined): string[] {
  if (value === undefined) {
    return ["English", "Korean"];
  }
  const names: string[] = [];
  for (const name of value.split(",").map((part) => part.trim())) {
    if (name === "" || /[\r\n"]/.test(name) || name.length > 40) {
      throw new UsageError(`Invalid --language "${value}": expected short language names separated by commas`);
    }
    if (!names.some((known) => known.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  }
  if (names.length > MAX_LANGUAGES) {
    throw new UsageError(`Invalid --language "${value}": at most ${MAX_LANGUAGES} languages`);
  }
  return names;
}
