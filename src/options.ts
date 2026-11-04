import { parseArgs } from "node:util";
import type { Options } from "./evaluate.ts";
import { type PullRequestRef, parsePullRequestUrl } from "./pr-url.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The service limit of each kind of monorepo: a small change affects fewer services than this.
 * A frontend change may touch one service, so its limit is 2; a backend one may touch two.
 */
export const SERVICE_LIMITS = { frontend: 2, backend: 3 } as const;

const DEFAULT_FINDING_PATTERN = "\\bP[12]\\b";

export const USAGE = `Usage: small-change <PR URL> (--kind frontend|backend | --max-services <n>) [options]

Decides whether a Bitbucket Cloud pull request is a small change. Exits 0 when it is, 1 when it
is not, and 2 on a usage error or when Bitbucket cannot be read.

Arguments:
  <PR URL>                 https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>

Options:
  --kind <kind>            The monorepo's kind: frontend (fewer than ${SERVICE_LIMITS.frontend} affected services, so
                           one at most) or backend (fewer than ${SERVICE_LIMITS.backend}, so two at most)
  --max-services <n>       Fewer than n affected services, instead of --kind
  --max-lines <n>          Fewer than n lines changed, added plus removed (default: 1000)
  --min-merged <n>         The author must have merged n PRs in each affected service (default: 10)
  --service-depth <n>      How many leading directories name a service (default: 2)
  --bot <name>             A review bot whose findings count: its name, nickname or UUID. Repeatable.
                           Without it, every commenter's findings count
  --finding-pattern <re>   A comment matching this case-insensitive regex is a finding
                           (default: ${DEFAULT_FINDING_PATTERN})
  --history-limit <n>      Read at most n of the author's merged PRs (default: 100)
  -h, --help               Show this help and exit

Environment:
  BITBUCKET_TOKEN          An access token for private repositories and higher rate limits`;

export type CliInput = { kind: "help" } | { kind: "run"; ref: PullRequestRef; options: Options };

/** Parses the command line (without `node` and the script path). Throws {@link UsageError}. */
export function parseCliArgs(argv: string[]): CliInput {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return { kind: "help" };
  }

  const [url, ...extra] = positionals;
  if (url === undefined) {
    throw new UsageError("Missing required argument: <PR URL>");
  }
  if (url === "review" || url === "model") {
    throw new UsageError(`The "${url}" command was removed: this tool only checks whether a PR is a small change`);
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

  return {
    kind: "run",
    ref,
    options: {
      maxLines: positive(values["max-lines"], "--max-lines") ?? 1000,
      maxServices: maxServices(values.kind, values["max-services"]),
      minMergedPullRequests: positive(values["min-merged"], "--min-merged") ?? 10,
      serviceDepth: positive(values["service-depth"], "--service-depth") ?? 2,
      bots: values.bot ?? [],
      findingPattern: pattern(values["finding-pattern"] ?? DEFAULT_FINDING_PATTERN),
      historyScanLimit: positive(values["history-limit"], "--history-limit") ?? 100,
    },
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      "max-services": { type: "string" },
      "max-lines": { type: "string" },
      "min-merged": { type: "string" },
      "service-depth": { type: "string" },
      bot: { type: "string", multiple: true },
      "finding-pattern": { type: "string" },
      "history-limit": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function maxServices(kind: string | undefined, explicit: string | undefined): number {
  if (kind !== undefined && explicit !== undefined) {
    throw new UsageError("Use either --kind or --max-services, not both");
  }
  if (explicit !== undefined) {
    return positive(explicit, "--max-services") as number;
  }
  if (kind === "frontend" || kind === "backend") {
    return SERVICE_LIMITS[kind];
  }
  if (kind === undefined) {
    throw new UsageError("Missing --kind frontend|backend (or --max-services <n>)");
  }
  throw new UsageError(`Invalid --kind "${kind}": expected frontend or backend`);
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

function pattern(source: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    throw new UsageError(`Invalid --finding-pattern "${source}": not a valid regular expression`);
  }
}
