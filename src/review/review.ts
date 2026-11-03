import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BitbucketReview } from "../bitbucket.ts";
import { agentEnv } from "../llm/exec.ts";
import type { Exec, Provider } from "../llm/types.ts";
import type { ModelConfig } from "../model-config.ts";
import type { PullRequestRef } from "../pr-url.ts";
import { formatComment, headline } from "./comment.ts";
import { type Finding, parseFindings } from "./findings.ts";
import { buildPrompt } from "./prompt.ts";

export interface ReviewOptions {
  maxFindings: number;
  /** A diff larger than this is refused, not truncated: a review of part of a PR would mislead. */
  maxDiffBytes: number;
  /** The language the findings are written in. */
  language: string;
  /** Whether to post the findings as comments. */
  post: boolean;
  timeoutMs: number;
}

export interface ReviewDeps {
  bitbucket: BitbucketReview;
  provider: Provider;
  exec: Exec;
  config: ModelConfig;
  env: NodeJS.ProcessEnv;
}

export interface ReviewResult {
  pullRequest: { ref: PullRequestRef; title: string; sourceCommit: string };
  /** `provider/model` as it appears in the comments' footer. */
  reviewer: string;
  findings: Finding[];
  /** Entries of the model's answer that were not findings. */
  dropped: number;
  /** Findings left out because of the limit. */
  omitted: number;
  /** Findings posted as comments, when asked to post. */
  posted: { finding: Finding; commentId: number }[];
  /** Findings not posted because a comment with the same headline exists. */
  alreadyPosted: Finding[];
}

/**
 * Reviews one PR: reads its diff, has the configured agent review it, and, when asked, posts each
 * finding as a comment. The agent runs in an empty directory with its tools off and without any
 * Bitbucket credential in its environment; posting is done here, never by the agent.
 */
export async function runReview(
  deps: ReviewDeps,
  ref: PullRequestRef,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const { bitbucket, provider, config } = deps;
  const [pullRequest, diff] = await Promise.all([bitbucket.getPullRequest(ref), bitbucket.getDiff(ref)]);

  const reviewer = `${provider.id}/${config.model}`;
  const result: ReviewResult = {
    pullRequest: { ref, title: pullRequest.title, sourceCommit: pullRequest.sourceCommit },
    reviewer,
    findings: [],
    dropped: 0,
    omitted: 0,
    posted: [],
    alreadyPosted: [],
  };
  if (diff.trim() === "") {
    return result;
  }
  const bytes = Buffer.byteLength(diff);
  if (bytes > options.maxDiffBytes) {
    throw new Error(
      `The diff is ${bytes} bytes, over the limit of ${options.maxDiffBytes}; raise --max-diff-bytes or review it by hand`,
    );
  }

  const workdir = await mkdtemp(join(tmpdir(), "small-change-review-"));
  let answer: string;
  try {
    answer = await provider.run(deps.exec, {
      prompt: buildPrompt({
        title: pullRequest.title,
        description: pullRequest.description,
        diff,
        language: options.language,
        maxFindings: options.maxFindings,
      }),
      model: config.model,
      effort: config.effort,
      workdir,
      env: agentEnv(deps.env),
      timeoutMs: options.timeoutMs,
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }

  const parsed = parseFindings(answer, options.maxFindings);
  result.findings = parsed.findings;
  result.dropped = parsed.dropped;
  result.omitted = parsed.omitted;

  if (options.post && parsed.findings.length > 0) {
    const footer = `small-change review · ${reviewer} · commit ${pullRequest.sourceCommit}`;
    const existing = (await bitbucket.getComments(ref)).map((comment) => comment.body.split("\n")[0]);
    for (const finding of parsed.findings) {
      if (existing.includes(headline(finding))) {
        result.alreadyPosted.push(finding);
        continue;
      }
      try {
        const commentId = await bitbucket.postComment(ref, formatComment(finding, footer));
        result.posted.push({ finding, commentId });
      } catch (error) {
        throw new Error(
          `Posted ${result.posted.length} of ${parsed.findings.length} comments before failing: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  }
  return result;
}

/** The result as text: one block per finding, then what happened to them. */
export function formatReview(result: ReviewResult, post: boolean): string {
  const { ref, title, sourceCommit } = result.pullRequest;
  const lines = [
    `${ref.workspace}/${ref.repo}#${ref.id} "${title}"`,
    `reviewed commit ${sourceCommit} with ${result.reviewer}`,
    "",
  ];
  for (const finding of result.findings) {
    const where = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
    lines.push(`${finding.severity}${where}  ${finding.title}`);
    for (const detailLine of finding.detail.split("\n").filter((line) => line.trim() !== "")) {
      lines.push(`      ${detailLine}`);
    }
  }
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    const counts = (["P1", "P2", "P3"] as const)
      .map((severity) => [severity, result.findings.filter((f) => f.severity === severity).length] as const)
      .filter(([, count]) => count > 0)
      .map(([severity, count]) => `${count} ${severity}`)
      .join(", ");
    lines.push("", `${result.findings.length} finding(s): ${counts}.`);
  }
  if (result.omitted > 0) {
    lines.push(`${result.omitted} more finding(s) were left out because of the limit.`);
  }
  if (result.dropped > 0) {
    lines.push(`${result.dropped} entry(ies) of the answer were not findings and were ignored.`);
  }
  if (result.findings.length > 0) {
    if (!post) {
      lines.push("Not posted. Run again with --post to post them as comments.");
    } else {
      lines.push(`Posted ${result.posted.length} comment(s).`);
      if (result.alreadyPosted.length > 0) {
        lines.push(`${result.alreadyPosted.length} already had a comment with the same headline and were skipped.`);
      }
    }
  }
  return lines.join("\n");
}
