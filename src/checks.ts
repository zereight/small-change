import type { FileChange, Person, ReviewComment } from "./bitbucket.ts";
import { EXCLUSION_FILE, type PathMatcher } from "./patterns.ts";
import { affectedServices } from "./services.ts";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  summary: string;
  details: string[];
}

function result(name: string, passed: boolean, summary: string, details: string[] = []): CheckResult {
  return { name, status: passed ? "pass" : "fail", summary, details };
}

export function skipped(name: string, reason: string): CheckResult {
  return { name, status: "skip", summary: reason, details: [] };
}

/** Every path a PR touches: both sides of a rename count. */
export function changedPaths(changes: FileChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    for (const path of [change.oldPath, change.newPath]) {
      if (path !== undefined) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}

/** The lines added plus removed must be fewer than `maxLines`. */
export function checkSize(changes: FileChange[], maxLines: number): CheckResult {
  const total = changes.reduce((sum, change) => sum + change.linesAdded + change.linesRemoved, 0);
  return result("size", total < maxLines, `${total} lines changed (must be fewer than ${maxLines})`);
}

/** The affected services must number fewer than `maxServices`. */
export function checkServices(services: string[], maxServices: number): CheckResult {
  return result(
    "services",
    services.length < maxServices,
    `${services.length} affected service(s) (must be fewer than ${maxServices})`,
    services,
  );
}

/**
 * No changed path may match the exclusion file's patterns, and the exclusion file itself may not
 * change: otherwise a PR could lift its own exclusions.
 */
export function checkExclusions(
  paths: string[],
  matcher: PathMatcher,
  exclusionFileFound: boolean,
): CheckResult {
  const excluded: string[] = [];
  for (const path of paths) {
    if (path === EXCLUSION_FILE) {
      excluded.push(`${path} (the exclusion file itself)`);
      continue;
    }
    const pattern = matcher.match(path);
    if (pattern !== undefined) {
      excluded.push(`${path} (excluded by "${pattern}")`);
    }
  }
  if (excluded.length > 0) {
    return result("exclusions", false, `${excluded.length} changed path(s) excluded`, excluded);
  }
  return result(
    "exclusions",
    true,
    `no changed path is excluded by ${EXCLUSION_FILE}`,
    exclusionFileFound ? [] : [`no ${EXCLUSION_FILE} file on the destination branch; nothing is excluded`],
  );
}

export interface FindingOptions {
  /** Names, nicknames or UUIDs of the review bots to read. Empty reads every commenter. */
  bots: string[];
  pattern: RegExp;
}

/** No unresolved comment from a review bot may match the finding pattern (P1 or P2 by default). */
export function checkReviewFindings(comments: ReviewComment[], options: FindingOptions): CheckResult {
  const bots = new Set(options.bots.map(normalize));
  const isFromBot = (person: Person) =>
    bots.size === 0 ||
    [person.uuid, person.name, person.nickname].some(
      (identity) => identity !== undefined && bots.has(normalize(identity)),
    );
  const findings = comments.filter(
    (comment) => !comment.resolved && isFromBot(comment.author) && options.pattern.test(comment.body),
  );
  const scope = bots.size === 0 ? "" : ` from ${options.bots.join(", ")}`;
  if (findings.length === 0) {
    return result("review-findings", true, `no unresolved finding${scope} matching ${options.pattern}`);
  }
  return result(
    "review-findings",
    false,
    `${findings.length} unresolved finding(s)${scope} matching ${options.pattern}`,
    findings.map((comment) => `#${comment.id} ${comment.author.name}: ${snippet(comment.body, options.pattern)}`),
  );
}

export interface HistoryInput {
  services: string[];
  /** Merged PRs the author must have in every affected service. */
  minMerged: number;
  /** How many of the author's merged PRs to inspect before giving up. */
  scanLimit: number;
  serviceDepth: number;
  /** The author's merged PRs, newest first. */
  mergedPullRequestIds: AsyncIterable<number>;
  pathsOf(pullRequestId: number): Promise<string[]>;
}

/**
 * The author must have merged at least `minMerged` PRs touching each affected service. The author's
 * merged PRs are inspected newest first, one at a time, until every service has enough or
 * `scanLimit` PRs have been read.
 */
export async function checkAuthorHistory(input: HistoryInput): Promise<CheckResult> {
  const name = "author-history";
  if (input.services.length === 0) {
    return result(name, true, "no service is affected");
  }
  const counts = new Map(input.services.map((service) => [service, 0]));
  const isEnough = () => [...counts.values()].every((count) => count >= input.minMerged);

  let scanned = 0;
  let exhausted = true;
  for await (const id of input.mergedPullRequestIds) {
    if (scanned >= input.scanLimit) {
      exhausted = false;
      break;
    }
    scanned++;
    const touched = new Set(affectedServices(await input.pathsOf(id), input.serviceDepth));
    for (const service of input.services) {
      if (touched.has(service)) {
        counts.set(service, (counts.get(service) ?? 0) + 1);
      }
    }
    if (isEnough()) {
      break;
    }
  }

  const details = input.services.map((service) => `${service}: ${counts.get(service)}/${input.minMerged}`);
  if (isEnough()) {
    return result(name, true, `the author has merged at least ${input.minMerged} PRs in each affected service`, details);
  }
  const lacking = [...counts.values()].filter((count) => count < input.minMerged).length;
  details.push(
    exhausted
      ? `read all ${scanned} merged PR(s) of the author`
      : `stopped after reading ${scanned} merged PRs (the scan limit)`,
  );
  return result(
    name,
    false,
    `the author lacks ${input.minMerged} merged PRs in ${lacking} of ${input.services.length} affected service(s)`,
    details,
  );
}

function normalize(identity: string): string {
  return identity.trim().toLowerCase().replace(/^\{|\}$/g, "");
}

function snippet(body: string, pattern: RegExp): string {
  const line = body.split("\n").find((candidate) => pattern.test(candidate)) ?? body;
  const text = line.trim().replace(/\s+/g, " ");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}
