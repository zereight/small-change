import type { BitbucketReview, PullRequest } from "../bitbucket.ts";
import type { Exec } from "../llm/types.ts";
import type { PullRequestRef } from "../pr-url.ts";
import { type Checkout, type CheckoutRequest, createCheckout } from "./checkout.ts";
import { type EngineContext, runNeed, type SearchEngine, type SearchId } from "./engines.ts";
import { LookupPool, type Need } from "./lookup.ts";

export type Agent = "reviewer" | "verifier";

/** What the lookups of one review did, for the report. */
export interface LookupSummary {
  engine: SearchId;
  label: string;
  /** `unavailable`: the checkout or the engine's setup failed, and the review went on without lookups. */
  status: "ok" | "unavailable";
  error?: string;
  /** How many times each agent asked for lookups. */
  asked: Record<Agent, number>;
  requests: number;
  failed: number;
  found: number;
  shown: number;
  /** Requests that were not valid, or beyond the limit. */
  ignored: number;
  log: { agent: Agent; title: string; found: number; shown: number; note?: string; failed?: boolean }[];
  timings: { checkoutMs: number; prepareMs: number; lookupMs: number };
}

export interface LookupSession {
  engine: SearchEngine;
  context: EngineContext;
  pool: LookupPool;
  summary: LookupSummary;
  dispose(): Promise<void>;
}

export interface SessionDeps {
  bitbucket: BitbucketReview;
  exec: Exec;
  env: NodeJS.ProcessEnv;
  engine: SearchEngine;
  /** Defaults to a real shallow clone; tests pass a stand-in. */
  createCheckout?: (request: CheckoutRequest) => Promise<Checkout>;
}

const CHECKOUT_TIMEOUT_MS = 300_000;
const PREPARE_TIMEOUT_MS = 300_000;
const LOOKUP_TIMEOUT_MS = 60_000;

/**
 * Fetches the PR's source commit and readies the engine on it. Any failure here means the review
 * goes on without lookups, and the summary says why: a PR from a private fork, a network error or
 * a broken index must not cost the whole review, and must not pass unseen either.
 */
export async function openLookups(
  deps: SessionDeps,
  ref: PullRequestRef,
  pullRequest: PullRequest,
): Promise<{ session?: LookupSession; summary: LookupSummary }> {
  const { engine } = deps;
  const summary: LookupSummary = {
    engine: engine.id,
    label: engine.label,
    status: "ok",
    asked: { reviewer: 0, verifier: 0 },
    requests: 0,
    failed: 0,
    found: 0,
    shown: 0,
    ignored: 0,
    log: [],
    timings: { checkoutMs: 0, prepareMs: 0, lookupMs: 0 },
  };
  let checkout: Checkout | undefined;
  try {
    const repository = pullRequest.sourceRepository ?? { workspace: ref.workspace, repo: ref.repo };
    const commit = /^[0-9a-f]{40,64}$/.test(pullRequest.sourceCommit)
      ? pullRequest.sourceCommit
      : await deps.bitbucket.getCommitHash(repository, pullRequest.sourceCommit);
    if (commit === undefined) {
      throw new Error("Bitbucket does not know the commit under review");
    }
    const make = deps.createCheckout ?? ((request: CheckoutRequest) => createCheckout(deps.exec, request, deps.env));
    const started = performance.now();
    checkout = await make({
      url: `https://bitbucket.org/${repository.workspace}/${repository.repo}.git`,
      commit,
      token: deps.env.BITBUCKET_TOKEN,
      worktree: engine.worktree,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    const fetched = performance.now();
    // The engines get the PATH and nothing else: not the Bitbucket token that the checkout used.
    const context: EngineContext = { exec: deps.exec, checkout, env: { PATH: deps.env.PATH ?? "" }, timeoutMs: LOOKUP_TIMEOUT_MS };
    await engine.prepare(context, PREPARE_TIMEOUT_MS);
    summary.timings.checkoutMs = fetched - started;
    summary.timings.prepareMs = performance.now() - fetched;
    const owned = checkout;
    return { summary, session: { engine, context, pool: new LookupPool(), summary, dispose: () => owned.dispose() } };
  } catch (error) {
    await checkout?.dispose();
    summary.status = "unavailable";
    summary.error = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
    return { summary };
  }
}

/** Runs what an agent asked for and adds the answers to the pool, skipping what it already holds. */
export async function answerNeeds(session: LookupSession, needs: readonly Need[], agent: Agent): Promise<void> {
  const started = performance.now();
  const { summary } = session;
  summary.asked[agent]++;
  for (const need of needs) {
    if (session.pool.has(need)) {
      continue;
    }
    const result = await runNeed(session.engine, session.context, need, session.pool);
    session.pool.add(result);
    summary.requests++;
    summary.failed += result.failed ? 1 : 0;
    summary.found += result.found;
    summary.shown += result.shown;
    summary.log.push({
      agent,
      title: result.title,
      found: result.found,
      shown: result.shown,
      ...(result.note === undefined ? {} : { note: result.note }),
      ...(result.failed ? { failed: true } : {}),
    });
  }
  summary.timings.lookupMs += performance.now() - started;
}

/** What the agents were shown by lookups, in the form a quote is checked against. */
export function shownByLookups(session: LookupSession | undefined): { path: string; shown: string }[] {
  return (session?.pool.seen() ?? []).map((seen) => ({ path: seen.path, shown: seen.text }));
}
