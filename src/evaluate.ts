import type { Bitbucket } from "./bitbucket.ts";
import {
  type CheckResult,
  changedPaths,
  checkAuthorHistory,
  checkExclusions,
  checkReviewFindings,
  checkServices,
  checkSize,
  skipped,
} from "./checks.ts";
import { EXCLUSION_FILE, NO_EXCLUSIONS, parseExclusions } from "./patterns.ts";
import type { PullRequestRef } from "./pr-url.ts";
import { affectedServices } from "./services.ts";

export interface Options {
  /** A small change touches fewer lines than this. */
  maxLines: number;
  /** A small change affects fewer services than this. */
  maxServices: number;
  /** The author must have merged this many PRs in each affected service. */
  minMergedPullRequests: number;
  /** How many leading directories name a service. */
  serviceDepth: number;
  /** Review bots whose findings count; empty counts every commenter's. */
  bots: string[];
  /** A comment matching this is a finding. */
  findingPattern: RegExp;
  /** How many of the author's merged PRs to read when counting their history. */
  historyScanLimit: number;
}

export interface Report {
  pullRequest: { ref: PullRequestRef; title: string; author: string };
  /** In the order the checks are reported. */
  results: CheckResult[];
  /** Whether every check passed. */
  eligible: boolean;
}

/**
 * Runs every check against one PR. The author-history check reads many PRs, so it runs only when
 * the other checks pass; otherwise the PR is not a small change whatever the history says.
 */
export async function evaluate(
  bitbucket: Bitbucket,
  ref: PullRequestRef,
  options: Options,
): Promise<Report> {
  const pullRequest = await bitbucket.getPullRequest(ref);
  // The exclusion file comes from the destination branch, not the PR's head, so a PR cannot
  // remove its own exclusions.
  const [changes, comments, exclusionText] = await Promise.all([
    bitbucket.getFileChanges(ref),
    bitbucket.getComments(ref),
    bitbucket.getFile(ref, pullRequest.destinationCommit, EXCLUSION_FILE),
  ]);

  const paths = changedPaths(changes);
  const services = affectedServices(paths, options.serviceDepth);
  const matcher = exclusionText === undefined ? NO_EXCLUSIONS : parseExclusions(exclusionText);

  const size = checkSize(changes, options.maxLines);
  const findings = checkReviewFindings(comments, {
    bots: options.bots,
    pattern: options.findingPattern,
  });
  const serviceCount = checkServices(services, options.maxServices);
  const exclusions = checkExclusions(paths, matcher, exclusionText !== undefined);

  const othersPassed = [size, findings, serviceCount, exclusions].every(
    (check) => check.status === "pass",
  );
  const history = othersPassed
    ? await checkAuthorHistory({
        services,
        minMerged: options.minMergedPullRequests,
        scanLimit: options.historyScanLimit,
        serviceDepth: options.serviceDepth,
        mergedPullRequestIds: bitbucket.listMergedPullRequestIds(ref, pullRequest.author.uuid),
        pathsOf: async (id) => changedPaths(await bitbucket.getFileChanges({ ...ref, id })),
      })
    : skipped("author-history", "not checked: another check already failed");

  const results = [size, findings, history, serviceCount, exclusions];
  return {
    pullRequest: { ref, title: pullRequest.title, author: pullRequest.author.name },
    results,
    eligible: results.every((check) => check.status === "pass"),
  };
}
