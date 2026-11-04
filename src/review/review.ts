import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BitbucketReview } from "../bitbucket.ts";
import { agentEnv } from "../llm/exec.ts";
import type { Exec, Provider } from "../llm/types.ts";
import type { ModelChoice, ModelConfig } from "../model-config.ts";
import type { PullRequestRef } from "../pr-url.ts";
import { formatComment, headline } from "./comment.ts";
import type { Checkout, CheckoutRequest } from "./checkout.ts";
import { buildContext, type ContextOmission } from "./context.ts";
import { type LeftOut, parseDiff, splitDiff } from "./diff.ts";
import { ENGINES, type SearchEngine, type SearchId } from "./engines.ts";
import { type Finding, parseFindings, SEVERITIES } from "./findings.ts";
import { type LookupMode, parseLookups } from "./lookup.ts";
import { buildQuoteChecker } from "./material.ts";
import { buildPrompt } from "./prompt.ts";
import { type Agent, answerNeeds, type LookupSession, type LookupSummary, openLookups, shownByLookups } from "./session.ts";
import { applyVerdict, buildVerifyPrompt, bySeverity, isBlocking, parseVerdicts } from "./verify.ts";

export interface ReviewOptions {
  maxFindings: number;
  /** A diff larger than this is reviewed in parts of at most this many bytes, cut between files. */
  maxDiffBytes: number;
  /** The most parts that are reviewed; a very large diff costs one run of the reviewer for each. */
  maxParts: number;
  /** The most code of the changed files, in bytes, that is shown besides the diff. Zero: the diff only. */
  contextBytes: number;
  /** Lines of code shown around each change, when a file is too large to be shown whole. */
  contextLines: number;
  /** The languages of the comments. The first is what the model writes in and the output uses; the others are translations of each comment's title and condition. */
  languages: string[];
  /** Whether to post the findings as comments. */
  post: boolean;
  /** Whether to have the verifier try to refute the P1 and P2 findings, when one is configured. */
  verifier: boolean;
  /** The engine that answers the agents' requests to see more code. `auto`: tgrep, else git grep. */
  search: SearchId | "auto" | "off";
  /** The most lookups one agent may ask for in a turn. */
  maxLookups: number;
  timeoutMs: number;
}

export interface ReviewDeps {
  bitbucket: BitbucketReview;
  provider: Provider;
  exec: Exec;
  config: ModelConfig;
  /** A second model that tries to refute each P1 and P2. Without one, the reviewer's grades stand. */
  verifier?: { provider: Provider; config: ModelChoice };
  env: NodeJS.ProcessEnv;
  /** Defaults to the real engines. */
  engines?: Record<SearchId, SearchEngine>;
  /** Defaults to a real shallow clone. */
  createCheckout?: (request: CheckoutRequest) => Promise<Checkout>;
}

export interface ReviewResult {
  pullRequest: { ref: PullRequestRef; title: string; sourceCommit: string };
  /** `provider/model` of the reviewer. */
  reviewer: string;
  /** How many parts the diff was cut into, each reviewed on its own: 1 for a diff that fits. */
  parts: number;
  /** Files, or all of a diff, that no part holds and so were not reviewed, with the reason. */
  notReviewed: LeftOut[];
  /** What the reviewer was shown besides the diff. */
  context: { enabled: boolean; files: number; bytes: number; omitted: ContextOmission[] };
  /** The findings after grading; a P1 or P2 that was not proven carries `lowered`. */
  findings: Finding[];
  /** Findings that lack a translation in one of the languages asked for: their comment is not in every language. */
  untranslated: number;
  /** Entries of the model's answer that were not findings. */
  dropped: number;
  /** Findings left out because of the limit. */
  omitted: number;
  /** What the verifier did, when it ran: `provider/model`, and how many P1/P2 it checked and refuted. */
  verification?: { by: string; checked: number; refuted: number; undecided: number };
  /** What the lookups did, when they were asked for. */
  lookups?: LookupSummary;
  /** Model runs per agent: one more for each turn that was spent on lookups. */
  calls: Record<Agent, number>;
  timings: { reviewerMs: number; verifierMs: number; totalMs: number };
  /** Findings posted as comments, when asked to post. */
  posted: { finding: Finding; commentId: number }[];
  /** Findings not posted because a comment with the same headline exists. */
  alreadyPosted: Finding[];
}

/**
 * Reviews one PR: reads its diff and the code around it, has the configured agent review it, and,
 * when asked, posts each finding as a comment. The agent runs in an empty directory with its tools
 * off and without any Bitbucket credential in its environment; this tool reads the files and
 * posts, never the agent. A P1 or P2 is kept only when its quotes are really in what was shown,
 * and, when a verifier is configured, only when a second model could not refute it with a quote of
 * its own. If the verifier fails, nothing is posted.
 *
 * With a search engine, each agent may answer its first turn with a list of lookups instead of its
 * result; this tool runs them on a checkout of the PR's commit and gives the agent one more turn
 * with the results. The agent still has no tools and no credential.
 */
export async function runReview(
  deps: ReviewDeps,
  ref: PullRequestRef,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const { bitbucket, provider, config } = deps;
  const started = performance.now();
  const { engine, fallback } = await chooseEngine(deps, options.search);
  const verifier = options.verifier ? deps.verifier : undefined;
  if (verifier !== undefined && !(await verifier.provider.isInstalled(deps.exec))) {
    throw new Error(
      `The verifier's \`${verifier.provider.binary}\` was not found on PATH; install it, or run with --no-verifier`,
    );
  }
  const [pullRequest, diff] = await Promise.all([bitbucket.getPullRequest(ref), bitbucket.getDiff(ref)]);

  const reviewer = `${provider.id}/${config.model}`;
  const result: ReviewResult = {
    pullRequest: { ref, title: pullRequest.title, sourceCommit: pullRequest.sourceCommit },
    reviewer,
    parts: 0,
    notReviewed: [],
    context: { enabled: options.contextBytes > 0, files: 0, bytes: 0, omitted: [] },
    findings: [],
    untranslated: 0,
    dropped: 0,
    omitted: 0,
    posted: [],
    alreadyPosted: [],
    calls: { reviewer: 0, verifier: 0 },
    timings: { reviewerMs: 0, verifierMs: 0, totalMs: 0 },
  };
  if (diff.trim() === "") {
    return result;
  }
  const split = splitDiff(diff, options.maxDiffBytes, options.maxParts);
  result.parts = split.parts.length;
  result.notReviewed = split.leftOut;
  if (split.parts.length === 0) {
    return result;
  }

  const opened =
    engine === undefined
      ? undefined
      : await openLookups(
          {
            bitbucket,
            exec: deps.exec,
            env: deps.env,
            engine,
            ...(deps.createCheckout === undefined ? {} : { createCheckout: deps.createCheckout }),
          },
          ref,
          pullRequest,
        );
  const session = opened?.session;
  if (opened !== undefined) {
    result.lookups = opened.summary;
    if (fallback !== undefined) {
      opened.summary.note = fallback;
    }
  }

  let verifierRuns = 0;
  try {
    const all: Finding[] = [];
    const verification = { by: "", checked: 0, refuted: 0, undecided: 0 };
    for (const [index, part] of split.parts.entries()) {
      const diffFiles = parseDiff(part);
      const context = await buildContext(
        diffFiles,
        (path) => bitbucket.getFile(pullRequest.sourceRepository ?? ref, pullRequest.sourceCommit, path),
        { lines: options.contextLines, totalBytes: options.contextBytes },
      );
      result.context = {
        enabled: options.contextBytes > 0,
        files: result.context.files + context.files.length,
        bytes: result.context.bytes + context.bytes,
        omitted: [...result.context.omitted, ...context.omitted],
      };
      const material = {
        title: pullRequest.title,
        description: pullRequest.description,
        diff: part,
        files: context.files,
        omitted: context.omitted,
      };

      const reviewerStarted = performance.now();
      const answer = await converse({
        deps,
        provider,
        choice: config,
        timeoutMs: options.timeoutMs,
        session,
        agent: "reviewer",
        maxLookups: options.maxLookups,
        prompt: (lookup, lookups) =>
          buildPrompt({
            ...material,
            lookups,
            ...(lookup === undefined ? {} : { lookup }),
            languages: options.languages,
            maxFindings: options.maxFindings,
            ...(split.parts.length > 1 ? { part: { index: index + 1, of: split.parts.length } } : {}),
          }),
      });
      result.timings.reviewerMs += performance.now() - reviewerStarted;
      // Built when needed: what the agents were shown by lookups grows as they ask.
      const check = () => buildQuoteChecker(diffFiles, [...context.files, ...shownByLookups(session)]);
      const parsed = parseFindings(answer, options.maxFindings, check(), options.languages.slice(1));
      result.dropped += parsed.dropped;
      result.omitted += parsed.omitted;
      let findings = parsed.findings;

      const candidates = findings.filter(isBlocking);
      if (verifier !== undefined && candidates.length > 0) {
        const by = `${verifier.provider.id}/${verifier.config.model}`;
        const verifierStarted = performance.now();
        let verdicts: ReturnType<typeof parseVerdicts>;
        try {
          const reply = await converse({
            deps,
            provider: verifier.provider,
            choice: verifier.config,
            timeoutMs: options.timeoutMs,
            session,
            agent: "verifier",
            maxLookups: options.maxLookups,
            prompt: (lookup, lookups) =>
              buildVerifyPrompt({
                ...material,
                lookups,
                ...(lookup === undefined ? {} : { lookup }),
                candidates,
                language: options.languages[0] ?? "English",
              }),
          });
          verdicts = parseVerdicts(reply, candidates, check());
        } catch (error) {
          throw new Error(
            `The verifier (${by}) failed, so nothing was posted: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        result.timings.verifierMs += performance.now() - verifierStarted;
        const verdictOf = new Map(candidates.map((finding, position) => [finding, verdicts[position]] as const));
        findings = findings.map((finding) => applyVerdict(finding, verdictOf.get(finding), by));
        verifierRuns++;
        verification.by = by;
        verification.checked += candidates.length;
        verification.refuted += verdicts.filter((verdict) => verdict?.verdict === "refuted").length;
        verification.undecided += verdicts.filter((verdict) => verdict === undefined || verdict.verdict === "unclear").length;
      }
      all.push(...findings);
    }
    const ranked = bySeverity(all);
    result.findings = ranked.slice(0, options.maxFindings);
    result.omitted += Math.max(0, ranked.length - options.maxFindings);
    if (verifierRuns > 0) {
      result.verification = verification;
    }
  } finally {
    await session?.dispose();
  }
  result.calls = {
    reviewer: split.parts.length + (result.lookups?.asked.reviewer ?? 0),
    verifier: verifierRuns + (result.lookups?.asked.verifier ?? 0),
  };

  const others = options.languages.slice(1);
  result.untranslated = result.findings.filter((finding) =>
    others.some((language) => finding.translations?.every((item) => item.language !== language) ?? true),
  ).length;

  if (options.post && result.findings.length > 0) {
    const existing = (await bitbucket.getComments(ref)).map((comment) => comment.body.split("\n")[0]);
    for (const finding of result.findings) {
      if (existing.includes(headline(finding))) {
        result.alreadyPosted.push(finding);
        continue;
      }
      try {
        const commentId = await bitbucket.postComment(ref, formatComment(finding, options.languages));
        result.posted.push({ finding, commentId });
      } catch (error) {
        throw new Error(
          `Posted ${result.posted.length} of ${result.findings.length} comments before failing: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  }
  result.timings.totalMs = performance.now() - started;
  return result;
}

/**
 * The engine for `--search`. `auto` is tgrep when it is installed, else git grep, and says so in
 * `fallback`; a named engine that is not installed is an error, found before anything is read.
 */
async function chooseEngine(
  deps: ReviewDeps,
  search: ReviewOptions["search"],
): Promise<{ engine?: SearchEngine; fallback?: string }> {
  if (search === "off") {
    return {};
  }
  const engines = deps.engines ?? ENGINES;
  if (search === "auto") {
    if (await engines.tgrep.isAvailable(deps.exec)) {
      return { engine: engines.tgrep };
    }
    if (await engines["git-grep"].isAvailable(deps.exec)) {
      return { engine: engines["git-grep"], fallback: `${engines.tgrep.needs} is not installed, so git grep was used` };
    }
    throw new Error(`--search auto needs ${engines.tgrep.needs} or ${engines["git-grep"].needs} on PATH; install one, or pass --search off`);
  }
  const engine = engines[search];
  if (!(await engine.isAvailable(deps.exec))) {
    throw new Error(`--search ${engine.id} needs ${engine.needs} on PATH; install it, or choose another --search`);
  }
  return { engine };
}

/**
 * Runs an agent. When it answers its first turn with a list of lookups, they are run and the
 * agent gets a second and last turn with the results in the material.
 */
async function converse(args: {
  deps: ReviewDeps;
  provider: Provider;
  choice: ModelChoice;
  timeoutMs: number;
  session: LookupSession | undefined;
  agent: Agent;
  maxLookups: number;
  prompt: (lookup: LookupMode | undefined, lookups: string) => string;
}): Promise<string> {
  const { session } = args;
  const mode = (final: boolean): LookupMode | undefined =>
    session === undefined ? undefined : { kinds: session.engine.kinds, max: args.maxLookups, final };
  const run = (prompt: string) => runAgent(args.deps, args.provider, args.choice, prompt, args.timeoutMs);

  const first = await run(args.prompt(mode(false), session?.pool.render() ?? ""));
  if (session === undefined) {
    return first;
  }
  const asked = parseLookups(first, session.engine.kinds, args.maxLookups);
  if (asked === undefined || asked.needs.length === 0) {
    return first;
  }
  session.summary.ignored += asked.dropped + asked.excess;
  await answerNeeds(session, asked.needs, args.agent);
  return run(args.prompt(mode(true), session.pool.render()));
}

/** Runs one agent on one prompt, in an empty directory, with no Bitbucket variable in its environment. */
async function runAgent(
  deps: ReviewDeps,
  provider: Provider,
  choice: ModelChoice,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "small-change-review-"));
  try {
    return await provider.run(deps.exec, {
      prompt,
      model: choice.model,
      effort: choice.effort,
      workdir,
      env: agentEnv(deps.env),
      timeoutMs,
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const SHOWN_OMISSIONS = 4;
const SHOWN_LOOKUPS = 12;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** What the lookups did: a line of totals and a line per request, then the time they took. */
function lookupLines(lookups: LookupSummary | undefined): string[] {
  if (lookups === undefined) {
    return [];
  }
  if (lookups.status === "unavailable") {
    return [`lookups: ${lookups.label} could not be used, so the review had no lookups: ${lookups.error ?? "unknown error"}`];
  }
  const { timings } = lookups;
  const lines = [
    ...(lookups.note === undefined ? [] : [`lookups: ${lookups.note}`]),
    `lookups: ${lookups.label}, ${lookups.requests} request(s) answered${lookups.failed > 0 ? ` (${lookups.failed} could not be run)` : ""}, ${lookups.shown} line(s) shown of ${lookups.found} found` +
      `${lookups.ignored > 0 ? `; ${lookups.ignored} request(s) were not valid or over the limit` : ""}` +
      `; checkout ${seconds(timings.checkoutMs)}, setup ${seconds(timings.prepareMs)}, requests ${seconds(timings.lookupMs)}`,
  ];
  for (const entry of lookups.log.slice(0, SHOWN_LOOKUPS)) {
    lines.push(`  ${entry.agent}: ${entry.title}: ${entry.failed ? `could not be run (${entry.note ?? "unknown"})` : `${entry.found} found${entry.shown < entry.found ? `, ${entry.shown} shown` : ""}`}`);
  }
  if (lookups.log.length > SHOWN_LOOKUPS) {
    lines.push(`  and ${lookups.log.length - SHOWN_LOOKUPS} more`);
  }
  return lines;
}

/** The result as text: what the reviewer was shown, one block per finding, then what happened to them. */
export function formatReview(result: ReviewResult, post: boolean): string {
  const { ref, title, sourceCommit } = result.pullRequest;
  const lines = [
    `${ref.workspace}/${ref.repo}#${ref.id} "${title}"`,
    `reviewed commit ${sourceCommit} with ${result.reviewer}`,
    ...(result.parts > 1 ? [`diff: large, so it was cut between files and reviewed in ${result.parts} parts`] : []),
    contextLine(result.context),
    ...lookupLines(result.lookups),
    ...(result.verification === undefined
      ? []
      : [
          `checked by ${result.verification.by}: ${result.verification.checked} P1/P2 checked, ${result.verification.refuted} refuted, ${result.verification.undecided} not decided`,
        ]),
    "",
  ];
  for (const finding of result.findings) {
    const where = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
    lines.push(`${finding.severity}${where}  ${finding.title}`);
    for (const detailLine of finding.detail.split("\n").filter((line) => line.trim() !== "")) {
      lines.push(`      ${detailLine}`);
    }
    if (finding.condition !== undefined) {
      lines.push(`      condition: ${finding.condition}`);
    }
    for (const quote of finding.evidence) {
      lines.push(`      evidence: ${quote.path ?? ""}${quote.line === undefined ? "" : `:${quote.line}`} ${oneLine(quote.quote)}`.replace(/ +/g, " "));
    }
    if (finding.lowered !== undefined) {
      lines.push(`      lowered from ${finding.lowered.from}: ${finding.lowered.reason}`);
    }
    if (finding.opinion !== undefined && finding.opinion.verdict !== "refuted") {
      lines.push(`      second reviewer: ${finding.opinion.verdict}${finding.opinion.reason === undefined ? "" : `: ${finding.opinion.reason}`}`);
    }
    if (finding.counter !== undefined) {
      const { path, line, quote } = finding.counter;
      lines.push(`      against it: ${path ?? ""}${line === undefined ? "" : `:${line}`} ${oneLine(quote)}`.replace(/ +/g, " "));
    }
  }
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    const counts = SEVERITIES.map((severity) => [severity, result.findings.filter((f) => f.severity === severity).length] as const)
      .filter(([, count]) => count > 0)
      .map(([severity, count]) => `${count} ${severity}`)
      .join(", ");
    lines.push("", `${result.findings.length} finding(s): ${counts}.`);
    const lowered = result.findings.filter((finding) => finding.lowered !== undefined).length;
    if (lowered > 0) {
      lines.push(`${lowered} of them were graded lower than the reviewer first said, because they were not proven or were refuted.`);
    }
  }
  if (result.untranslated > 0) {
    lines.push(`${result.untranslated} finding(s) came without a translation in every language asked for, so their comment is not in all of them.`);
  }
  if (result.omitted > 0) {
    lines.push(`${result.omitted} more finding(s) were left out because of the limit.`);
  }
  if (result.dropped > 0) {
    lines.push(`${result.dropped} entry(ies) of the answer were not findings and were ignored.`);
  }
  if (result.notReviewed.length > 0) {
    const listed = result.notReviewed.slice(0, SHOWN_OMISSIONS).map((entry) => `${entry.path} (${entry.bytes} bytes, ${entry.reason})`);
    const rest = result.notReviewed.length - listed.length;
    lines.push(
      `NOT REVIEWED: ${result.notReviewed.length} file(s) were in no part, so nothing was looked for in them: ${listed.join("; ")}${rest > 0 ? `; and ${rest} more (see --json)` : ""}`,
      "To review them, raise --max-diff-bytes or --max-parts.",
    );
  }
  lines.push(
    `time: reviewer ${seconds(result.timings.reviewerMs)} (${result.calls.reviewer} run(s))` +
      `${result.calls.verifier > 0 ? `, verifier ${seconds(result.timings.verifierMs)} (${result.calls.verifier} run(s))` : ""}` +
      `, total ${seconds(result.timings.totalMs)}`,
  );
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

function contextLine(context: ReviewResult["context"]): string {
  if (!context.enabled) {
    return "context: the diff only";
  }
  const parts = [`context: ${context.files} file(s) shown besides the diff (${context.bytes} bytes)`];
  if (context.omitted.length > 0) {
    const listed = context.omitted.slice(0, SHOWN_OMISSIONS).map((entry) => `${entry.path} (${entry.reason})`);
    const rest = context.omitted.length - listed.length;
    parts.push(`not shown: ${listed.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`);
  }
  return parts.join("; ");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
