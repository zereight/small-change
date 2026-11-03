import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BitbucketReview, ReviewComment } from "../src/bitbucket.ts";
import type { Exec, Provider, RunRequest } from "../src/llm/types.ts";
import type { ModelConfig } from "../src/model-config.ts";
import type { Finding } from "../src/review/findings.ts";
import { formatReview, type ReviewOptions, type ReviewResult, runReview } from "../src/review/review.ts";

const REF = { workspace: "team", repo: "repo", id: 5 };
const CONFIG: ModelConfig = { version: 1, provider: "claude", model: "opus", budget: "large", effort: "xhigh" };
const OPTIONS: ReviewOptions = {
  maxFindings: 10,
  maxDiffBytes: 5000,
  contextBytes: 100_000,
  contextLines: 40,
  language: "English",
  post: true,
  timeoutMs: 1000,
};
const NO_EXEC: Exec = async () => assert.fail("exec must not be called directly");

const DIFF = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -2,2 +2,3 @@
 const a = 1;
-const b = 2;
+const b = a - 1;
+export { a, b };
`;
const FILE = "const header = 0;\nconst a = 1;\nconst b = a - 1;\nexport { a, b };\nconst footer = 9;\n";

interface World {
  diff?: string;
  description?: string;
  comments?: string[];
  answer?: string;
  failPostAt?: number;
  files?: Record<string, string | Error>;
}

function setup(world: World) {
  const posted: string[] = [];
  const requests: RunRequest[] = [];
  const reads: string[] = [];
  const bitbucket: BitbucketReview = {
    async getPullRequest() {
      return {
        id: 5,
        title: "Add thing",
        description: world.description ?? "desc",
        author: { uuid: "{a}", name: "A" },
        sourceCommit: "abc123def456",
        destinationCommit: "dest",
      };
    },
    async getDiff() {
      return world.diff ?? DIFF;
    },
    async getComments() {
      return (world.comments ?? []).map((body, index): ReviewComment => ({ id: index, author: { uuid: "{b}", name: "B" }, body, resolved: false }));
    },
    async postComment(_ref, body) {
      if (world.failPostAt === posted.length) {
        throw new Error("403 forbidden");
      }
      posted.push(body);
      return 900 + posted.length;
    },
    async getFile(_repo, commit, path) {
      reads.push(`${commit}:${path}`);
      const value = (world.files ?? { "src/x.ts": FILE })[path];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
    async getFileChanges() {
      return assert.fail("not used");
    },
    async *listMergedPullRequestIds() {
      assert.fail("not used");
    },
  };
  const provider: Provider = {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    effortStyle: "flag",
    isInstalled: async () => true,
    listModels: async () => undefined,
    suggestedModels: [],
    async run(_exec, request) {
      requests.push(request);
      return world.answer ?? '{"findings":[]}';
    },
  };
  const env = { PATH: "/bin", BITBUCKET_TOKEN: "secret-token", BITBUCKET_API_TOKEN: "secret-2" };
  return { bitbucket, provider, posted, requests, reads, deps: { bitbucket, provider, exec: NO_EXEC, config: CONFIG, env } };
}

const answer = (...findings: object[]) => JSON.stringify({ findings });
/** A finding that is proven by the diff above. */
const proven = (extra: object = {}) => ({
  severity: "P1",
  basis: "code",
  title: "Bug",
  detail: "bad",
  path: "src/x.ts",
  line: 3,
  condition: "a is 0",
  evidence: [{ path: "src/x.ts", line: 3, quote: "const b = a - 1;" }],
  ...extra,
});

describe("runReview", () => {
  it("gives the agent the diff and the code around it, in an empty directory, with no Bitbucket variable, and the configured model", async () => {
    const world = setup({ answer: answer() });
    await runReview(world.deps, REF, OPTIONS);
    const [request] = world.requests;
    assert.ok(request?.prompt.includes("diff --git a/src/x.ts b/src/x.ts"));
    assert.ok(request?.prompt.includes("3| const b = a - 1;"));
    assert.equal(request?.model, "opus");
    assert.equal(request?.effort, "xhigh");
    assert.equal(request?.timeoutMs, 1000);
    assert.deepEqual(request?.env, { PATH: "/bin" });
    assert.match(request?.workdir ?? "", /small-change-review-/);
  });

  it("reads each changed file at the PR's source commit", async () => {
    const world = setup({ answer: answer() });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(world.reads, ["abc123def456:src/x.ts"]);
    assert.equal(result.context.files, 1);
    assert.equal(result.context.enabled, true);
  });

  it("shows the diff only when the context size is zero, and reads no file", async () => {
    const world = setup({ answer: answer() });
    const result = await runReview(world.deps, REF, { ...OPTIONS, contextBytes: 0 });
    assert.deepEqual(world.reads, []);
    assert.match(world.requests[0]?.prompt ?? "", /\(none: only the diff is available\)/);
    assert.equal(result.context.enabled, false);
  });

  it("goes on without a file it cannot read, and reports it", async () => {
    const world = setup({ files: { "src/x.ts": new Error("HTTP 500") }, answer: answer() });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.context.files, 0);
    assert.deepEqual(result.context.omitted, [{ path: "src/x.ts", reason: "could not be read: HTTP 500" }]);
    assert.match(world.requests[0]?.prompt ?? "", /Not shown:\n- src\/x\.ts: could not be read: HTTP 500/);
  });

  it("posts each finding as a comment with the reviewer and commit in the footer, keeping a proven P1 a P1", async () => {
    const world = setup({ answer: answer(proven(), { severity: "P3", title: "Nit", detail: "" }) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.posted.length, 2);
    assert.equal(result.reviewer, "claude/opus");
    assert.equal(world.posted[0]?.split("\n")[0], "**P1** Bug");
    assert.match(world.posted[0] ?? "", /Condition: a is 0/);
    assert.match(world.posted[0] ?? "", /small-change review · claude\/opus · commit abc123def456/);
  });

  it("posts a P1 that was not proven as a P3 and says why, so it cannot block the check", async () => {
    const world = setup({ answer: answer(proven({ evidence: [{ path: "src/x.ts", quote: "const invented = somethingElse();" }] })) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P3");
    assert.equal(world.posted[0]?.split("\n")[0], "**P3** Bug");
    assert.match(world.posted[0] ?? "", /_Graded P3, not P1: no evidence quote was found in the code shown\._/);
    assert.ok(!/\bP[12]\b/.test(world.posted[0]?.split("\n")[0] ?? ""));
  });

  it("accepts a quote from the expanded code that is not in the diff", async () => {
    const world = setup({ answer: answer(proven({ evidence: [{ path: "src/x.ts", line: 1, quote: "const header = 0;" }] })) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P1");
  });

  it("does not accept that quote when only the diff was shown", async () => {
    const world = setup({ answer: answer(proven({ evidence: [{ path: "src/x.ts", line: 1, quote: "const header = 0;" }] })) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, contextBytes: 0 });
    assert.equal(result.findings[0]?.severity, "P3");
  });

  it("does not post without --post", async () => {
    const world = setup({ answer: answer(proven()) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, post: false });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(world.posted, []);
  });

  it("skips a finding whose headline an existing comment already opens with", async () => {
    const world = setup({
      comments: ["**P1** Bug\n\nold detail", "unrelated"],
      answer: answer(proven(), proven({ severity: "P2", title: "New one", line: 2 })),
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(world.posted.map((body) => body.split("\n")[0]), ["**P2** New one"]);
    assert.equal(result.alreadyPosted.length, 1);
  });

  it("reports how many comments went out when a post fails", async () => {
    const world = setup({ failPostAt: 1, answer: answer(proven({ title: "a" }), proven({ title: "b", severity: "P2" })) });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /Posted 1 of 2 comments before failing: 403 forbidden/);
  });

  it("refuses a diff over the limit instead of reviewing part of it, and never reads a file or calls the agent", async () => {
    const world = setup({ diff: "x".repeat(5001) });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /over the limit of 5000/);
    assert.equal(world.requests.length, 0);
    assert.deepEqual(world.reads, []);
  });

  it("does not call the agent for an empty diff", async () => {
    const world = setup({ diff: "  \n" });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(result.findings, []);
    assert.equal(world.requests.length, 0);
  });

  it("fails on an answer that is not JSON, posting nothing", async () => {
    const world = setup({ answer: "LGTM" });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /not JSON/);
    assert.deepEqual(world.posted, []);
  });

  it("applies the findings limit", async () => {
    const findings = [1, 2, 3].map((n) => proven({ severity: "P2", title: `t${n}` }));
    const world = setup({ answer: answer(...findings) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, maxFindings: 2 });
    assert.equal(result.findings.length, 2);
    assert.equal(result.omitted, 1);
  });
});

describe("formatReview", () => {
  const finding = (extra: Partial<Finding>): Finding => ({ severity: "P2", title: "x", detail: "", basis: "code", evidence: [], ...extra });
  const base: ReviewResult = {
    pullRequest: { ref: REF, title: "Add thing", sourceCommit: "abc" },
    reviewer: "claude/opus",
    context: { enabled: true, files: 2, bytes: 1234, omitted: [] },
    findings: [],
    dropped: 0,
    omitted: 0,
    posted: [],
    alreadyPosted: [],
  };

  it("says what was shown and that there were no findings", () => {
    const text = formatReview(base, true);
    assert.match(text, /team\/repo#5 "Add thing"/);
    assert.match(text, /context: 2 file\(s\) shown besides the diff \(1234 bytes\)/);
    assert.match(text, /No findings\./);
    assert.ok(!text.includes("Posted"));
  });

  it("lists what was not shown, a few at a time, and says when the diff alone was used", () => {
    const omitted = ["a", "b", "c", "d", "e", "f"].map((name) => ({ path: `${name}.ts`, reason: "lock file" }));
    assert.match(formatReview({ ...base, context: { ...base.context, omitted } }, true), /not shown: a\.ts \(lock file\); b\.ts \(lock file\); c\.ts \(lock file\); d\.ts \(lock file\); and 2 more/);
    assert.match(formatReview({ ...base, context: { enabled: false, files: 0, bytes: 0, omitted: [] } }, true), /context: the diff only/);
  });

  it("lists findings with their condition, evidence and why one was lowered, and counts them", () => {
    const findings: Finding[] = [
      finding({ severity: "P1", title: "Bug", detail: "line one\nline two", path: "a.ts", line: 3, condition: "a is 0", evidence: [{ path: "a.ts", line: 3, quote: "const b = a - 1;" }] }),
      finding({ severity: "P3", title: "Nit", lowered: { from: "P2", reason: "no trigger condition was given" } }),
      finding({ severity: "ASK", title: "Is it ok?" }),
    ];
    const text = formatReview({ ...base, findings }, false);
    assert.match(text, /P1 a\.ts:3  Bug/);
    assert.match(text, /condition: a is 0/);
    assert.match(text, /evidence: a\.ts:3 const b = a - 1;/);
    assert.match(text, /lowered from P2: no trigger condition was given/);
    assert.match(text, /3 finding\(s\): 1 P1, 1 P3, 1 ASK\./);
    assert.match(text, /1 of them were graded lower than the reviewer first said/);
    assert.match(text, /Not posted\. Run again with --post/);
  });

  it("reports posted, skipped, omitted and dropped counts", () => {
    const one = finding({});
    const text = formatReview({ ...base, findings: [one], posted: [{ finding: one, commentId: 1 }], alreadyPosted: [one], omitted: 2, dropped: 1 }, true);
    assert.match(text, /Posted 1 comment\(s\)\./);
    assert.match(text, /1 already had a comment/);
    assert.match(text, /2 more finding\(s\) were left out/);
    assert.match(text, /1 entry\(ies\) of the answer were not findings/);
  });
});
