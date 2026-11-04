import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BitbucketReview, PullRequest } from "../src/bitbucket.ts";
import type { Exec } from "../src/llm/types.ts";
import type { Checkout, CheckoutRequest } from "../src/review/checkout.ts";
import type { Hit, SearchEngine } from "../src/review/engines.ts";
import type { Need } from "../src/review/lookup.ts";
import { answerNeeds, openLookups, shownByLookups } from "../src/review/session.ts";

const REF = { workspace: "team", repo: "repo", id: 7 };
const HASH = "d".repeat(40);
const NO_EXEC: Exec = async () => assert.fail("exec must not be called");
const grep = (pattern: string): Need => ({ kind: "grep", pattern, regex: false, ignoreCase: false });

const pullRequest = (extra: Partial<PullRequest> = {}): PullRequest => ({
  id: 7,
  title: "t",
  description: "",
  author: { uuid: "{a}", name: "A" },
  sourceCommit: "d".repeat(12),
  destinationCommit: "e".repeat(12),
  ...extra,
});

function parts(options: { hits?: Hit[]; prepare?: SearchEngine["prepare"]; hash?: string | undefined } = {}) {
  const hashes: string[] = [];
  const requests: CheckoutRequest[] = [];
  const disposed: string[] = [];
  const bitbucket = {
    async getCommitHash(repository: { workspace: string; repo: string }, commit: string) {
      hashes.push(`${repository.workspace}/${repository.repo}@${commit}`);
      return "hash" in options ? options.hash : HASH;
    },
  } as unknown as BitbucketReview;
  const engine: SearchEngine = {
    id: "tgrep",
    label: "tgrep",
    needs: "`tgrep`",
    worktree: true,
    kinds: ["grep", "file"],
    isAvailable: async () => true,
    prepare: options.prepare ?? (async () => {}),
    grep: async () => options.hits ?? [{ path: "a.kt", line: 1, text: "import X" }],
  };
  const createCheckout = async (request: CheckoutRequest): Promise<Checkout> => {
    requests.push(request);
    return { dir: "/fake", commit: request.commit, worktree: request.worktree, scratch: "/fake-scratch", dispose: async () => { disposed.push("/fake"); } };
  };
  return { bitbucket, engine, createCheckout, hashes, requests, disposed };
}

describe("openLookups", () => {
  it("resolves a short hash, clones that commit with the engine's needs, and readies the engine", async () => {
    const made = parts();
    const opened = await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: { PATH: "/bin", BITBUCKET_TOKEN: "tok" }, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    assert.equal(opened.summary.status, "ok");
    assert.ok(opened.session !== undefined);
    assert.deepEqual(made.hashes, [`team/repo@${"d".repeat(12)}`]);
    assert.deepEqual(made.requests.map((request) => [request.url, request.commit, request.token, request.worktree]), [
      ["https://bitbucket.org/team/repo.git", HASH, "tok", true],
    ]);
    assert.ok(opened.summary.timings.checkoutMs >= 0);
  });

  it("does not ask Bitbucket for a hash that is already complete, and uses the source repository for a fork", async () => {
    const made = parts();
    await openLookups(
      { bitbucket: made.bitbucket, exec: NO_EXEC, env: { PATH: "/bin" }, engine: made.engine, createCheckout: made.createCheckout },
      REF,
      pullRequest({ sourceCommit: HASH, sourceRepository: { workspace: "fork", repo: "r2" } }),
    );
    assert.deepEqual(made.hashes, []);
    assert.equal(made.requests[0]?.url, "https://bitbucket.org/fork/r2.git");
  });

  it("gives the engine the PATH and nothing else", async () => {
    let seen: Record<string, string | undefined> | undefined;
    const made = parts({ prepare: async (context) => { seen = context.env; } });
    await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: { PATH: "/bin", BITBUCKET_TOKEN: "tok", HOME: "/home/x" }, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    assert.deepEqual(seen, { PATH: "/bin" });
  });

  it("reports an unknown commit, and deletes nothing because nothing was made", async () => {
    const made = parts({ hash: undefined });
    const opened = await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: {}, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    assert.equal(opened.summary.status, "unavailable");
    assert.match(opened.summary.error ?? "", /does not know the commit/);
    assert.equal(opened.session, undefined);
    assert.deepEqual(made.disposed, []);
  });

  it("deletes the checkout when the engine's setup fails, and keeps the error to one short line", async () => {
    const made = parts({ prepare: async () => { throw new Error(`index failed\n${"x".repeat(1000)}`); } });
    const opened = await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: {}, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    assert.equal(opened.summary.status, "unavailable");
    assert.deepEqual(made.disposed, ["/fake"]);
    assert.ok((opened.summary.error ?? "").length <= 300);
    assert.ok(!(opened.summary.error ?? "").includes("\n"));
  });

  it("session.dispose deletes the checkout", async () => {
    const made = parts();
    const opened = await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: {}, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    await opened.session?.dispose();
    assert.deepEqual(made.disposed, ["/fake"]);
  });
});

describe("answerNeeds", () => {
  async function open(hits?: Hit[]) {
    const made = parts(hits === undefined ? {} : { hits });
    const opened = await openLookups({ bitbucket: made.bitbucket, exec: NO_EXEC, env: {}, engine: made.engine, createCheckout: made.createCheckout }, REF, pullRequest());
    assert.ok(opened.session !== undefined);
    return opened.session;
  }

  it("runs each request, logs it with who asked, and keeps what a quote may cite", async () => {
    const session = await open();
    await answerNeeds(session, [grep("import X")], "reviewer");
    await answerNeeds(session, [grep("other")], "verifier");
    assert.equal(session.summary.requests, 2);
    assert.deepEqual(session.summary.asked, { reviewer: 1, verifier: 1 });
    assert.deepEqual(session.summary.log.map((entry) => entry.agent), ["reviewer", "verifier"]);
    assert.equal(session.summary.found, 2);
    assert.deepEqual(shownByLookups(session), [{ path: "a.kt", shown: "import X" }, { path: "a.kt", shown: "import X" }]);
    assert.ok(session.summary.timings.lookupMs >= 0);
  });

  it("does not run a request the pool already answered", async () => {
    const session = await open();
    await answerNeeds(session, [grep("import X")], "reviewer");
    await answerNeeds(session, [grep("import X")], "verifier");
    assert.equal(session.summary.requests, 1);
    assert.equal(session.summary.asked.verifier, 1);
  });

  it("counts requests that could not be run", async () => {
    const session = await open();
    await answerNeeds(session, [{ kind: "callers", symbol: "foo" }], "reviewer");
    assert.equal(session.summary.failed, 1);
    assert.equal(session.summary.log[0]?.failed, true);
  });

  it("shows nothing for a session that does not exist", () => {
    assert.deepEqual(shownByLookups(undefined), []);
  });
});
