import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BitbucketReview, PullRequest, ReviewComment } from "../src/bitbucket.ts";
import type { Exec, Provider, RunRequest } from "../src/llm/types.ts";
import type { ModelConfig } from "../src/model-config.ts";
import type { Checkout, CheckoutRequest } from "../src/review/checkout.ts";
import type { Hit, SearchEngine } from "../src/review/engines.ts";
import type { Finding } from "../src/review/findings.ts";
import { formatReview, type ReviewOptions, type ReviewResult, runReview } from "../src/review/review.ts";

const REF = { workspace: "team", repo: "repo", id: 5 };
const CONFIG: ModelConfig = { version: 1, provider: "claude", model: "opus", budget: "large", effort: "xhigh" };
const VERIFIER = { provider: "muse" as const, model: "muse-spark-1.3", budget: "medium" as const, effort: "high" as const };
const OPTIONS: ReviewOptions = {
  maxFindings: 10,
  maxDiffBytes: 5000,
  maxParts: 6,
  contextBytes: 100_000,
  contextLines: 40,
  languages: ["English", "Korean"],
  post: true,
  verifier: true,
  search: "off",
  maxLookups: 8,
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
  /** The reviewer's answers, one per run; `answer` after them. */
  answers?: string[];
  /** Fields of the pull request to set besides the defaults. */
  pullRequest?: Partial<PullRequest>;
  failPostAt?: number;
  /** What the full hash of the source commit is, or undefined if Bitbucket does not know it. */
  hash?: string | undefined;
  files?: Record<string, string | Error>;
  /** A second model; its answer, or the error it fails with, or that it is not installed. */
  verifier?: { answer?: string; answers?: string[]; error?: string; installed?: boolean };
}

function setup(world: World) {
  const posted: string[] = [];
  const requests: RunRequest[] = [];
  const reads: string[] = [];
  const hashes: string[] = [];
  const bitbucket: BitbucketReview = {
    async getPullRequest() {
      return {
        id: 5,
        title: "Add thing",
        description: world.description ?? "desc",
        author: { uuid: "{a}", name: "A" },
        sourceCommit: "abc123def456",
        destinationCommit: "dest",
        ...world.pullRequest,
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
    async getCommitHash(_repo, commit) {
      hashes.push(commit);
      return "hash" in world ? world.hash : "a".repeat(40);
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
      return world.answers?.[requests.length - 1] ?? world.answer ?? '{"findings":[]}';
    },
  };
  const verifierRequests: RunRequest[] = [];
  const second: Provider = {
    ...provider,
    id: "muse",
    label: "Muse",
    binary: "muse",
    isInstalled: async () => world.verifier?.installed ?? true,
    async run(_exec, request) {
      verifierRequests.push(request);
      if (world.verifier?.error !== undefined) {
        throw new Error(world.verifier.error);
      }
      return world.verifier?.answers?.[verifierRequests.length - 1] ?? world.verifier?.answer ?? '{"verdicts":[]}';
    },
  };
  const env = { PATH: "/bin", BITBUCKET_TOKEN: "secret-token", BITBUCKET_API_TOKEN: "secret-2" };
  const verifier = world.verifier === undefined ? {} : { verifier: { provider: second, config: VERIFIER } };
  return { bitbucket, provider, posted, requests, verifierRequests, reads, hashes, deps: { bitbucket, provider, exec: NO_EXEC, config: CONFIG, ...verifier, env } };
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

  it("posts each finding as a comment of grade, title, place, condition and evidence only, keeping a proven P1 a P1", async () => {
    const world = setup({ answer: answer(proven(), { severity: "P3", title: "Nit", detail: "" }) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.posted.length, 2);
    assert.equal(result.reviewer, "claude/opus");
    assert.equal(world.posted[0]?.split("\n")[0], "**P1** Bug");
    assert.match(world.posted[0] ?? "", /Condition: a is 0/);
    assert.match(world.posted[0] ?? "", /Evidence \/ 증거:\n- /);
    for (const gone of ["small-change review", "claude/opus", "abc123def456", "Graded", "Firing"]) {
      assert.ok(!(world.posted[0] ?? "").includes(gone), gone);
    }
  });

  it("posts the Korean translation the reviewer gave, and counts the findings that came without one", async () => {
    const translated = proven({ translations: [{ language: "Korean", title: "버그", condition: "a가 0일 때" }] });
    const world = setup({ answer: answer(translated, proven({ title: "Other", line: 3 })) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.untranslated, 1);
    assert.match(world.posted[0] ?? "", /^\*\*P1\*\* Bug\n버그\n\n/);
    assert.match(world.posted[0] ?? "", /Condition: a is 0\n조건: a가 0일 때/);
    assert.equal(world.posted[1]?.split("\n")[1], "", "no Korean line when the reviewer gave none");
    assert.match(world.requests[0]?.prompt ?? "", /for each of Korean/);
  });

  it("asks for no translations, and counts none missing, when only one language is asked for", async () => {
    const world = setup({ answer: answer(proven()) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, languages: ["English"] });
    assert.equal(result.untranslated, 0);
    assert.doesNotMatch(world.requests[0]?.prompt ?? "", /translations/);
  });

  it("posts a P1 that was not proven as a P3 and says why, so it cannot block the check", async () => {
    const world = setup({ answer: answer(proven({ evidence: [{ path: "src/x.ts", quote: "const invented = somethingElse();" }] })) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P3");
    assert.equal(world.posted[0]?.split("\n")[0], "**P3** Bug");
    assert.ok(!/\bP[12]\b/.test(world.posted[0] ?? ""), "the check, which reads the whole comment, does not count a P3");
    assert.ok(!(world.posted[0] ?? "").includes("no evidence quote"), "why it was lowered stays in the output, not the comment");
    assert.match(formatReview(result, true), /lowered from P1: no evidence quote was found in the code shown/);
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

  describe("a diff over --max-diff-bytes", () => {
    const fileDiff = (name: string, code: string) =>
      `diff --git a/src/${name} b/src/${name}\n--- a/src/${name}\n+++ b/src/${name}\n@@ -1 +1,2 @@\n const a = 1;\n+${code}\n`;
    const X = fileDiff("x.ts", "const b = a - 1;");
    const Y = fileDiff("y.ts", "const c = a - 2;");
    const Z = fileDiff("z.ts", "const d = a - 3;");
    const limit = Buffer.byteLength(X) + 5; // one file to a part
    const files = {
      "src/x.ts": "const a = 1;\nconst b = a - 1;\n",
      "src/y.ts": "const a = 1;\nconst c = a - 2;\n",
      "src/z.ts": "const a = 1;\nconst d = a - 3;\n",
    };
    const finding = (name: string, code: string, extra: object = {}) =>
      proven({ path: `src/${name}`, line: 2, title: `Bug in ${name}`, evidence: [{ path: `src/${name}`, line: 2, quote: code }], ...extra });
    const split = { ...OPTIONS, maxDiffBytes: limit };

    it("is reviewed in parts, cut between files, each with its own code, and the findings are merged most severe first", async () => {
      const world = setup({
        diff: X + Y + Z,
        files,
        answers: [
          answer(finding("x.ts", "const b = a - 1;", { severity: "P2" })),
          answer(),
          answer(finding("z.ts", "const d = a - 3;", { severity: "P1" }), finding("z.ts", "const d = a - 3;", { severity: "P3", title: "Nit in z" })),
        ],
      });
      const result = await runReview(world.deps, REF, split);
      assert.equal(result.parts, 3);
      assert.deepEqual(result.notReviewed, []);
      assert.deepEqual(result.calls, { reviewer: 3, verifier: 0 });
      assert.equal(world.requests.length, 3);
      const [first, second, third] = world.requests.map((request) => request.prompt);
      assert.ok(first?.includes("src/x.ts") && !first.includes("src/y.ts") && !first.includes("src/z.ts"));
      assert.ok(second?.includes("src/y.ts") && !second.includes("src/x.ts"));
      assert.ok(third?.includes("src/z.ts") && !third.includes("src/y.ts"));
      assert.match(first ?? "", /reviewed in 3 parts, and this is part 1\./);
      assert.match(third ?? "", /this is part 3\./);
      assert.deepEqual(result.findings.map((item) => item.severity), ["P1", "P2", "P3"]);
      assert.deepEqual(world.posted.map((body) => body.split("\n")[0]), ["**P1** Bug in z.ts", "**P2** Bug in x.ts", "**P3** Nit in z"]);
      assert.deepEqual([...world.reads].sort(), ["abc123def456:src/x.ts", "abc123def456:src/y.ts", "abc123def456:src/z.ts"], "each file is read once");
      assert.equal(result.context.files, 3);
    });

    it("does not accept a quote from a part that the reviewer was not shown with", async () => {
      const world = setup({
        diff: X + Y,
        files,
        answers: [answer(finding("x.ts", "const c = a - 2;", { severity: "P1", evidence: [{ path: "src/y.ts", line: 2, quote: "const c = a - 2;" }] })), answer()],
      });
      const result = await runReview(world.deps, REF, split);
      assert.equal(result.findings[0]?.severity, "P3", "its proof is in the other part");
      assert.equal(result.findings[0]?.lowered?.from, "P1");
    });

    it("applies the findings limit to all the parts together, keeping the most severe", async () => {
      const world = setup({
        diff: X + Y,
        files,
        answers: [answer(finding("x.ts", "const b = a - 1;", { severity: "P2" })), answer(finding("y.ts", "const c = a - 2;", { severity: "P1" }))],
      });
      const result = await runReview(world.deps, REF, { ...split, maxFindings: 1 });
      assert.deepEqual(result.findings.map((item) => item.title), ["Bug in y.ts"]);
      assert.equal(result.omitted, 1);
    });

    it("stops at --max-parts and lists the files after it as not reviewed, in the output too", async () => {
      const world = setup({ diff: X + Y + Z, files, answer: answer() });
      const result = await runReview(world.deps, REF, { ...split, maxParts: 1 });
      assert.equal(result.parts, 1);
      assert.equal(world.requests.length, 1);
      assert.deepEqual(result.notReviewed.map((entry) => entry.path), ["src/y.ts", "src/z.ts"]);
      assert.match(formatReview(result, false), /NOT REVIEWED: 2 file\(s\) were in no part, so nothing was looked for in them: src\/y\.ts \(\d+ bytes, it is past the last of 1 part\(s\)\); src\/z\.ts/);
      assert.match(formatReview(result, false), /raise --max-diff-bytes or --max-parts/);
    });

    it("lists a file that alone is over the limit, reviews the rest, and calls no agent when nothing is left", async () => {
      const big = fileDiff("big.ts", "x".repeat(limit));
      const world = setup({ diff: X + big, files, answer: answer() });
      const result = await runReview(world.deps, REF, split);
      assert.deepEqual(result.notReviewed.map((entry) => entry.path), ["src/big.ts"]);
      assert.equal(world.requests.length, 1);

      const alone = setup({ diff: big, files });
      const nothing = await runReview(alone.deps, REF, split);
      assert.equal(alone.requests.length, 0);
      assert.deepEqual(alone.reads, [], "no file is read when no part is reviewed");
      assert.deepEqual(nothing.findings, []);
      assert.equal(nothing.parts, 0);
      assert.match(formatReview(nothing, true), /NOT REVIEWED: 1 file\(s\)/);
    });

    it("sends a diff that fits as one part, without saying it is in parts", async () => {
      const world = setup({ diff: X + Y, files, answer: answer() });
      const result = await runReview(world.deps, REF, { ...OPTIONS, maxDiffBytes: 100_000 });
      assert.equal(result.parts, 1);
      assert.doesNotMatch(world.requests[0]?.prompt ?? "", /reviewed in \d+ parts/);
      assert.doesNotMatch(formatReview(result, false), /cut between files/);
    });
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

describe("runReview with a verifier", () => {
  const refute = (id: number, extra: object = {}) => ({
    id,
    verdict: "refuted",
    reason: "the comment says it is deliberate.",
    counter: { path: "src/x.ts", line: 3, quote: "const b = a - 1;" },
    ...extra,
  });
  const verdicts = (...entries: object[]) => JSON.stringify({ verdicts: entries });

  it("is not run without a configured verifier, or with --no-verifier", async () => {
    const none = setup({ answer: answer(proven()) });
    const result = await runReview(none.deps, REF, OPTIONS);
    assert.equal(result.verification, undefined);
    assert.equal(result.findings[0]?.severity, "P1");

    const off = setup({ answer: answer(proven()), verifier: { error: "must not run" } });
    const skipped = await runReview(off.deps, REF, { ...OPTIONS, verifier: false });
    assert.equal(skipped.verification, undefined);
    assert.equal(off.verifierRequests.length, 0);
  });

  it("checks the P1 and P2 of each part with the code of that part, and adds up what it did", async () => {
    const fileDiff = (name: string, code: string) =>
      `diff --git a/src/${name} b/src/${name}\n--- a/src/${name}\n+++ b/src/${name}\n@@ -1 +1,2 @@\n const a = 1;\n+${code}\n`;
    const X = fileDiff("x.ts", "const b = a - 1;");
    const Y = fileDiff("y.ts", "const c = a - 2;");
    const finding = (name: string, code: string) =>
      proven({ severity: "P2", path: `src/${name}`, line: 2, title: `Bug in ${name}`, evidence: [{ path: `src/${name}`, line: 2, quote: code }] });
    const world = setup({
      diff: X + Y,
      files: { "src/x.ts": "const a = 1;\nconst b = a - 1;\n", "src/y.ts": "const a = 1;\nconst c = a - 2;\n" },
      answers: [answer(finding("x.ts", "const b = a - 1;")), answer(finding("y.ts", "const c = a - 2;"))],
      verifier: {
        answers: [
          verdicts(refute(1, { counter: { path: "src/x.ts", line: 2, quote: "const b = a - 1;" } })),
          verdicts({ id: 1, verdict: "upheld" }),
        ],
      },
    });
    const result = await runReview(world.deps, REF, { ...OPTIONS, maxDiffBytes: Buffer.byteLength(X) + 5 });
    assert.equal(world.verifierRequests.length, 2);
    assert.ok(world.verifierRequests[0]?.prompt.includes("src/x.ts") && !world.verifierRequests[0].prompt.includes("src/y.ts"));
    assert.ok(world.verifierRequests[1]?.prompt.includes("src/y.ts") && !world.verifierRequests[1].prompt.includes("src/x.ts"));
    assert.deepEqual(result.verification, { by: "muse/muse-spark-1.3", checked: 2, refuted: 1, undecided: 0 });
    assert.deepEqual(result.calls, { reviewer: 2, verifier: 2 });
    assert.deepEqual(result.findings.map((item) => [item.title, item.severity]), [["Bug in y.ts", "P2"], ["Bug in x.ts", "P3"]]);
  });

  it("posts nothing when the verifier fails on a later part", async () => {
    const fileDiff = (name: string, code: string) =>
      `diff --git a/src/${name} b/src/${name}\n--- a/src/${name}\n+++ b/src/${name}\n@@ -1 +1,2 @@\n const a = 1;\n+${code}\n`;
    const X = fileDiff("x.ts", "const b = a - 1;");
    const Y = fileDiff("y.ts", "const c = a - 2;");
    const world = setup({
      diff: X + Y,
      files: { "src/x.ts": "const a = 1;\nconst b = a - 1;\n", "src/y.ts": "const a = 1;\nconst c = a - 2;\n" },
      answers: [answer(), answer(proven({ path: "src/y.ts", line: 2, evidence: [{ path: "src/y.ts", line: 2, quote: "const c = a - 2;" }] }))],
      verifier: { error: "timed out" },
    });
    await assert.rejects(runReview(world.deps, REF, { ...OPTIONS, maxDiffBytes: Buffer.byteLength(X) + 5 }), /The verifier \(muse\/muse-spark-1\.3\) failed, so nothing was posted: timed out/);
    assert.deepEqual(world.posted, []);
  });

  it("is not asked about findings that are not P1 or P2, and not run when there are none", async () => {
    const world = setup({ answer: answer({ severity: "P3", title: "Nit", detail: "" }), verifier: { error: "must not run" } });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(world.verifierRequests.length, 0);
    assert.equal(result.verification, undefined);
    assert.equal(result.findings.length, 1);
  });

  it("shows the second model the same code, the candidates only, in an empty directory with no Bitbucket variable", async () => {
    const world = setup({
      answer: answer(proven(), proven({ severity: "P2", title: "Second", line: 2 }), { severity: "P3", title: "Nit", detail: "" }),
      verifier: { answer: verdicts({ id: 1, verdict: "upheld" }, { id: 2, verdict: "upheld" }) },
    });
    await runReview(world.deps, REF, OPTIONS);
    const [request] = world.verifierRequests;
    assert.ok(request?.prompt.includes("3| const b = a - 1;") && request.prompt.includes("diff --git a/src/x.ts b/src/x.ts"));
    assert.ok(request?.prompt.includes("[1] P1") && request.prompt.includes("[2] P2") && !request.prompt.includes("Nit"));
    assert.equal(request?.model, "muse-spark-1.3");
    assert.equal(request?.effort, "high");
    assert.equal(request?.timeoutMs, 1000);
    assert.deepEqual(request?.env, { PATH: "/bin" });
    assert.match(request?.workdir ?? "", /small-change-review-/);
    assert.notEqual(request?.workdir, world.requests[0]?.workdir);
  });

  it("posts a refuted P2 as a P3 without the second reviewer's side, which stays in the output", async () => {
    const world = setup({
      answer: answer(proven({ severity: "P2" })),
      verifier: { answer: verdicts(refute(1)) },
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P3");
    assert.deepEqual(result.verification, { by: "muse/muse-spark-1.3", checked: 1, refuted: 1, undecided: 0 });
    assert.equal(world.posted[0]?.split("\n")[0], "**P3** Bug");
    assert.ok(!/\bP[12]\b/.test(world.posted[0] ?? ""), "a finding the second reviewer refuted is not counted by the check");
    for (const gone of ["Graded", "Against it", "refuted", "checked by", "muse/muse-spark-1.3", "deliberate"]) {
      assert.ok(!(world.posted[0] ?? "").includes(gone), gone);
    }
    const output = formatReview(result, true);
    assert.match(output, /lowered from P2: the second reviewer \(muse\/muse-spark-1\.3\) refuted it: the comment says it is deliberate/);
    assert.match(output, /checked by muse\/muse-spark-1\.3: 1 P1\/P2 checked, 1 refuted/);
  });

  it("keeps what is upheld, unclear or unanswered, and counts the undecided", async () => {
    const world = setup({
      answer: answer(proven({ title: "a" }), proven({ title: "b", severity: "P2", line: 2 }), proven({ title: "c", severity: "P2", line: 4 })),
      verifier: { answer: verdicts({ id: 1, verdict: "upheld" }, { id: 2, verdict: "unclear", reason: "cannot tell" }) },
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(result.findings.map((f) => f.severity), ["P1", "P2", "P2"]);
    assert.deepEqual(result.verification, { by: "muse/muse-spark-1.3", checked: 3, refuted: 0, undecided: 2 });
  });

  it("does not take a refutation whose quote is not in the code shown", async () => {
    const world = setup({
      answer: answer(proven()),
      verifier: { answer: verdicts(refute(1, { counter: { path: "src/x.ts", quote: "if (handledElsewhere(value)) return;" } })) },
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P1");
    assert.equal(result.verification?.refuted, 0);
    assert.equal(result.verification?.undecided, 1);
  });

  it("accepts a counter quote from the expanded code that is not in the diff", async () => {
    const world = setup({
      answer: answer(proven()),
      verifier: { answer: verdicts(refute(1, { counter: { path: "src/x.ts", line: 1, quote: "const header = 0;" } })) },
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.findings[0]?.severity, "P3");
  });

  it("puts the findings in order again after lowering one", async () => {
    const world = setup({
      answer: answer(proven({ title: "first" }), proven({ title: "second", severity: "P2", line: 2 })),
      verifier: { answer: verdicts(refute(1)) },
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(result.findings.map((f) => `${f.severity} ${f.title}`), ["P2 second", "P3 first"]);
  });

  it("stops without posting anything when the verifier fails, is not JSON, or has no verdicts", async () => {
    for (const verifier of [{ error: "timed out" }, { answer: "looks fine" }, { answer: '{"findings":[]}' }]) {
      const world = setup({ answer: answer(proven(), { severity: "P3", title: "Nit", detail: "" }), verifier });
      await assert.rejects(
        runReview(world.deps, REF, OPTIONS),
        /The verifier \(muse\/muse-spark-1\.3\) failed, so nothing was posted: /,
      );
      assert.deepEqual(world.posted, []);
    }
  });

  it("stops before reading anything when the verifier's CLI is missing", async () => {
    const world = setup({ answer: answer(proven()), verifier: { installed: false } });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /The verifier's `muse` was not found on PATH.*--no-verifier/);
    assert.equal(world.requests.length, 0);
    assert.deepEqual(world.reads, []);
  });

  it("does not check the verifier's CLI when --no-verifier is given", async () => {
    const world = setup({ answer: answer(), verifier: { installed: false } });
    await runReview(world.deps, REF, { ...OPTIONS, verifier: false });
  });
});

describe("runReview with lookups", () => {
  const HASH = "a".repeat(40);
  const CALLER = "export const sync = () => start(); // called from login only";

  /** An engine that answers every grep with the given hits and records what it was asked. */
  function fakeEngine(hits: Hit[] = [{ path: "src/login.ts", line: 12, text: CALLER }], overrides: Partial<SearchEngine> = {}) {
    const asked: string[] = [];
    const prepared: string[] = [];
    const engine: SearchEngine = {
      id: "git-grep",
      label: "git grep",
      needs: "`git`",
      worktree: false,
      kinds: ["grep", "file"],
      isAvailable: async () => true,
      prepare: async (context) => {
        prepared.push(context.checkout.dir);
      },
      grep: async (_context, need) => {
        asked.push(need.pattern);
        return hits;
      },
      ...overrides,
    };
    return { engine, asked, prepared };
  }

  function fakeCheckout() {
    const requests: CheckoutRequest[] = [];
    const disposed: string[] = [];
    const create = async (request: CheckoutRequest): Promise<Checkout> => {
      requests.push(request);
      return { dir: "/fake/dir", commit: request.commit, worktree: request.worktree, scratch: "/fake/scratch", dispose: async () => { disposed.push("/fake/dir"); } };
    };
    return { create, requests, disposed };
  }

  const asks = (...entries: object[]) => JSON.stringify({ lookups: entries });
  const search = { ...OPTIONS, search: "git-grep" as const };

  function withLookups(world: World, engine: SearchEngine, checkout = fakeCheckout()) {
    const made = setup(world);
    return { ...made, checkout, deps: { ...made.deps, engines: { "git-grep": engine, tgrep: engine, graft: engine }, createCheckout: checkout.create } };
  }

  it("does nothing for lookups, and does not mention them to the agent, without --search", async () => {
    const { engine, asked } = fakeEngine();
    const made = withLookups({ answer: answer() }, engine);
    const result = await runReview(made.deps, REF, OPTIONS);
    assert.equal(result.lookups, undefined);
    assert.deepEqual(asked, []);
    assert.equal(made.checkout.requests.length, 0);
    assert.doesNotMatch(made.requests[0]?.prompt ?? "", /lookups/);
    assert.deepEqual(result.calls, { reviewer: 1, verifier: 0 });
  });

  describe("--search auto", () => {
    const auto = { ...OPTIONS, search: "auto" as const };
    const named = (id: "tgrep" | "git-grep", available: boolean) =>
      fakeEngine(undefined, { id, label: id === "tgrep" ? "tgrep" : "git grep", needs: id === "tgrep" ? "`tgrep` 1.2.6 or newer" : "`git`", isAvailable: async () => available });

    function twoEngines(tgrepAvailable: boolean, gitAvailable = true) {
      const t = named("tgrep", tgrepAvailable);
      const g = named("git-grep", gitAvailable);
      const made = setup({ answers: [asks({ grep: "sync()" }), answer()] });
      const checkout = fakeCheckout();
      return { t, g, made, checkout, deps: { ...made.deps, engines: { tgrep: t.engine, "git-grep": g.engine, graft: g.engine }, createCheckout: checkout.create } };
    }

    it("uses tgrep when it is installed", async () => {
      const { t, g, deps } = twoEngines(true);
      const result = await runReview(deps, REF, auto);
      assert.deepEqual(t.asked, ["sync()"]);
      assert.deepEqual(g.asked, []);
      assert.equal(result.lookups?.engine, "tgrep");
      assert.equal(result.lookups?.note, undefined);
    });

    it("uses git grep when tgrep is not installed, and says so", async () => {
      const { t, g, deps } = twoEngines(false);
      const result = await runReview(deps, REF, auto);
      assert.deepEqual(t.asked, []);
      assert.deepEqual(g.asked, ["sync()"]);
      assert.equal(result.lookups?.note, "`tgrep` 1.2.6 or newer is not installed, so git grep was used");
      assert.match(formatReview(result, false), /lookups: `tgrep` 1.2.6 or newer is not installed, so git grep was used/);
    });

    it("stops before anything is read when neither is installed", async () => {
      const { deps, made } = twoEngines(false, false);
      await assert.rejects(runReview(deps, REF, auto), /--search auto needs `tgrep` 1.2.6 or newer or `git` on PATH/);
      assert.equal(made.requests.length, 0);
      assert.deepEqual(made.reads, []);
    });

    it("does not fall back from an engine that was named", async () => {
      const { deps, made } = twoEngines(false);
      await assert.rejects(runReview(deps, REF, { ...OPTIONS, search: "tgrep" }), /--search tgrep needs `tgrep` 1.2.6 or newer on PATH/);
      assert.equal(made.requests.length, 0);
    });
  });

  it("stops before anything is read when the engine's program is missing", async () => {
    const { engine } = fakeEngine(undefined, { isAvailable: async () => false, id: "tgrep", needs: "`tgrep` 1.2.6 or newer" });
    const made = withLookups({ answer: answer() }, engine);
    await assert.rejects(runReview(made.deps, REF, { ...search, search: "tgrep" }), /--search tgrep needs `tgrep` 1.2.6 or newer on PATH/);
    assert.equal(made.requests.length, 0);
    assert.deepEqual(made.reads, []);
    assert.equal(made.checkout.requests.length, 0);
  });

  it("offers lookups on the first turn, runs them, and gives the results on a last turn where more may not be asked", async () => {
    const { engine, asked, prepared } = fakeEngine();
    const made = withLookups({ answers: [asks({ grep: "sync()" }), answer()] }, engine);
    const result = await runReview(made.deps, REF, search);
    assert.equal(made.requests.length, 2);
    assert.match(made.requests[0]?.prompt ?? "", /at most 8 lookups/);
    assert.doesNotMatch(made.requests[0]?.prompt ?? "", /Lookup results \(code of the repository/);
    assert.match(made.requests[1]?.prompt ?? "", /Lookup results \(code of the repository/);
    assert.match(made.requests[1]?.prompt ?? "", /src\/login\.ts:12\| export const sync/);
    assert.match(made.requests[1]?.prompt ?? "", /last turn: answer with findings now/);
    assert.deepEqual(asked, ["sync()"]);
    assert.deepEqual(prepared, ["/fake/dir"]);
    assert.deepEqual(result.calls, { reviewer: 2, verifier: 0 });
    assert.equal(result.lookups?.status, "ok");
    assert.equal(result.lookups?.requests, 1);
    assert.deepEqual(result.lookups?.asked, { reviewer: 1, verifier: 0 });
  });

  it("runs the agent once when it answers with findings on the first turn, and a lookup count of zero", async () => {
    const { engine, asked } = fakeEngine();
    const made = withLookups({ answers: [answer(proven())] }, engine);
    const result = await runReview(made.deps, REF, search);
    assert.equal(made.requests.length, 1);
    assert.deepEqual(asked, []);
    assert.equal(result.findings[0]?.severity, "P1");
    assert.equal(result.lookups?.requests, 0);
  });

  it("takes a quote from a lookup result as proof, and a quote the agent was never shown as no proof", async () => {
    const { engine } = fakeEngine();
    const fromLookup = { path: "src/login.ts", line: 12, quote: "export const sync = () => start();" };
    const invented = { path: "src/login.ts", line: 40, quote: "if (user.isAdmin) { grantEverything(); }" };
    const made = withLookups(
      {
        answers: [
          asks({ grep: "sync()" }),
          answer(proven({ evidence: [fromLookup], path: "src/login.ts", line: 12, title: "Proven by lookup" }), proven({ evidence: [invented], path: "src/login.ts", line: 40, title: "Invented" })),
        ],
      },
      engine,
    );
    const result = await runReview(made.deps, REF, search);
    const byTitle = new Map(result.findings.map((finding) => [finding.title, finding]));
    assert.equal(byTitle.get("Proven by lookup")?.severity, "P1");
    assert.equal(byTitle.get("Invented")?.severity, "P3");
    assert.ok(byTitle.get("Invented")?.lowered !== undefined);
  });

  it("ignores findings that come in the same answer as lookups", async () => {
    const { engine } = fakeEngine();
    const both = JSON.stringify({ findings: [proven()], lookups: [{ grep: "sync()" }] });
    const made = withLookups({ answers: [both, answer()] }, engine);
    const result = await runReview(made.deps, REF, search);
    assert.equal(made.requests.length, 2);
    assert.deepEqual(result.findings, []);
  });

  it("answers a request once and counts requests that were not valid or beyond the limit", async () => {
    const { engine, asked } = fakeEngine();
    const made = withLookups({ answers: [asks({ grep: "one" }, { grep: "one" }, { grep: "ab" }, { grep: "two" }, { grep: "three" }), answer()] }, engine);
    const result = await runReview(made.deps, REF, { ...search, maxLookups: 2 });
    assert.deepEqual(asked, ["one", "two"]);
    assert.equal(result.lookups?.requests, 2);
    assert.equal(result.lookups?.ignored >= 2, true);
  });

  it("gives the checkout the token but the engine only the PATH, and clones the full hash into the source repository", async () => {
    const seen: string[] = [];
    const { engine } = fakeEngine(undefined, {
      prepare: async (context) => {
        seen.push(JSON.stringify(context.env));
      },
    });
    const made = withLookups({ answer: answer(), pullRequest: { sourceRepository: { workspace: "fork-team", repo: "fork" } } }, engine);
    await runReview({ ...made.deps, env: { ...made.deps.env, BITBUCKET_TOKEN: "secret-token" } }, REF, search);
    assert.deepEqual(made.checkout.requests.map((request) => [request.url, request.commit, request.token, request.worktree]), [
      ["https://bitbucket.org/fork-team/fork.git", HASH, "secret-token", false],
    ]);
    assert.deepEqual(seen, ['{"PATH":"/bin"}']);
    assert.deepEqual(made.hashes, ["abc123def456"]);
  });

  it("deletes the checkout when the review is done, and when it fails", async () => {
    const { engine } = fakeEngine();
    const done = withLookups({ answers: [asks({ grep: "sync()" }), answer()] }, engine);
    await runReview(done.deps, REF, search);
    assert.deepEqual(done.checkout.disposed, ["/fake/dir"]);

    const broken = withLookups({ answers: [asks({ grep: "sync()" }), "not json"] }, engine);
    await assert.rejects(runReview(broken.deps, REF, search));
    assert.deepEqual(broken.checkout.disposed, ["/fake/dir"]);
  });

  it("goes on without lookups when the checkout fails, and says so", async () => {
    const { engine } = fakeEngine();
    const made = withLookups({ answer: answer(proven()) }, engine);
    const failing = async () => {
      throw new Error("git fetch failed: fatal: could not read Username");
    };
    const result = await runReview({ ...made.deps, createCheckout: failing }, REF, search);
    assert.equal(result.lookups?.status, "unavailable");
    assert.match(result.lookups?.error ?? "", /could not read Username/);
    assert.equal(made.requests.length, 1);
    assert.doesNotMatch(made.requests[0]?.prompt ?? "", /lookups/);
    assert.equal(result.findings[0]?.severity, "P1");
    assert.match(formatReview(result, false), /lookups: git grep could not be used, so the review had no lookups: git fetch failed/);
  });

  it("goes on without lookups when the engine's setup fails, and deletes the checkout", async () => {
    const { engine } = fakeEngine(undefined, { prepare: async () => { throw new Error("tgrep index failed"); } });
    const made = withLookups({ answer: answer() }, engine);
    const result = await runReview(made.deps, REF, search);
    assert.equal(result.lookups?.status, "unavailable");
    assert.deepEqual(made.checkout.disposed, ["/fake/dir"]);
  });

  it("goes on without lookups when Bitbucket does not know the commit", async () => {
    const { engine } = fakeEngine();
    const made = withLookups({ answer: answer(), hash: undefined }, engine);
    const result = await runReview(made.deps, REF, search);
    assert.equal(result.lookups?.status, "unavailable");
    assert.match(result.lookups?.error ?? "", /does not know the commit/);
    assert.equal(made.checkout.requests.length, 0);
  });

  it("shows the verifier the same results, lets it ask for more, and takes a counter quote from them", async () => {
    const { engine, asked } = fakeEngine();
    const counter = { path: "src/login.ts", line: 12, quote: "export const sync = () => start();" };
    const made = withLookups(
      {
        answers: [asks({ grep: "sync()" }), answer(proven({ severity: "P2" }))],
        verifier: {
          answers: [
            asks({ grep: "start(" }),
            JSON.stringify({ verdicts: [{ id: 1, verdict: "refuted", reason: "sync is only called at login.", counter }] }),
          ],
        },
      },
      engine,
    );
    const result = await runReview(made.deps, REF, search);
    assert.deepEqual(asked, ["sync()", "start("]);
    assert.match(made.verifierRequests[0]?.prompt ?? "", /Lookup results \(code of the repository/);
    assert.match(made.verifierRequests[0]?.prompt ?? "", /src\/login\.ts:12\|/);
    assert.match(made.verifierRequests[1]?.prompt ?? "", /last turn/);
    assert.equal(result.findings[0]?.severity, "P3");
    assert.equal(result.verification?.refuted, 1);
    assert.deepEqual(result.calls, { reviewer: 2, verifier: 2 });
    assert.deepEqual(result.lookups?.asked, { reviewer: 1, verifier: 1 });
  });

  it("does not name the engine or the commit in a comment, and counts the answered lookups in the output", async () => {
    const { engine } = fakeEngine();
    const used = withLookups({ answers: [asks({ grep: "sync()" }), answer({ severity: "P3", title: "Nit", detail: "" })] }, engine);
    const usedResult = await runReview(used.deps, REF, { ...search, post: true });
    assert.doesNotMatch(used.posted[0] ?? "", /looked up/);
    assert.match(formatReview(usedResult, true), /lookups: git grep, 1 request\(s\) answered/);

    const unused = withLookups({ answers: [answer({ severity: "P3", title: "Nit", detail: "" })] }, engine);
    const unusedResult = await runReview(unused.deps, REF, { ...search, post: true });
    assert.match(formatReview(unusedResult, true), /lookups: git grep, 0 request\(s\) answered/);
  });

  it("measures the time of each agent", async () => {
    const { engine } = fakeEngine();
    const result = await runReview(withLookups({ answer: answer() }, engine).deps, REF, search);
    assert.ok(result.timings.totalMs >= result.timings.reviewerMs);
    assert.ok(result.timings.reviewerMs >= 0);
  });
});

describe("formatReview", () => {
  const finding = (extra: Partial<Finding>): Finding => ({ severity: "P2", title: "x", detail: "", basis: "code", evidence: [], ...extra });
  const base: ReviewResult = {
    pullRequest: { ref: REF, title: "Add thing", sourceCommit: "abc" },
    reviewer: "claude/opus",
    parts: 1,
    notReviewed: [],
    context: { enabled: true, files: 2, bytes: 1234, omitted: [] },
    findings: [],
    untranslated: 0,
    dropped: 0,
    omitted: 0,
    posted: [],
    alreadyPosted: [],
    calls: { reviewer: 1, verifier: 0 },
    timings: { reviewerMs: 61_400, verifierMs: 0, totalMs: 62_000 },
  };

  it("says the diff was cut into parts, and lists what was not reviewed, a few and how many more", () => {
    const entry = (n: number) => ({ path: `src/f${n}.ts`, bytes: 100 * n, reason: "it is past the last of 2 part(s)" });
    const text = formatReview({ ...base, parts: 3, notReviewed: [1, 2, 3, 4, 5, 6].map(entry) }, false);
    assert.match(text, /diff: large, so it was cut between files and reviewed in 3 parts/);
    assert.match(text, /NOT REVIEWED: 6 file\(s\) were in no part, so nothing was looked for in them: src\/f1\.ts \(100 bytes, it is past the last of 2 part\(s\)\); src\/f2\.ts/);
    assert.match(text, /src\/f4\.ts[^;]*; and 2 more \(see --json\)/);
    assert.ok(!text.includes("src/f5.ts"));
    const plain = formatReview(base, false);
    assert.doesNotMatch(plain, /NOT REVIEWED|cut between files/);
  });

  it("says how many findings are not in every language, and nothing when all are", () => {
    assert.doesNotMatch(formatReview({ ...base, findings: [finding({})] }, true), /translation/);
    assert.match(formatReview({ ...base, findings: [finding({})], untranslated: 1 }, true), /1 finding\(s\) came without a translation in every language asked for/);
  });

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

  it("says what the verifier did, and shows the quote against a refuted finding", () => {
    const refuted: Finding = {
      ...finding({ severity: "P3", title: "Was a P2" }),
      lowered: { from: "P2", reason: "the second reviewer (muse/m) refuted it: it is deliberate" },
      counter: { path: "a.ts", line: 4, quote: "// sent again at the next login" },
    };
    const text = formatReview(
      { ...base, findings: [refuted], verification: { by: "muse/m", checked: 3, refuted: 1, undecided: 1 } },
      false,
    );
    assert.match(text, /checked by muse\/m: 3 P1\/P2 checked, 1 refuted, 1 not decided/);
    assert.match(text, /lowered from P2: the second reviewer \(muse\/m\) refuted it: it is deliberate/);
    assert.match(text, /against it: a\.ts:4 \/\/ sent again at the next login/);
    assert.doesNotMatch(text, /second reviewer:/);
    const kept = formatReview(
      { ...base, findings: [finding({ severity: "P1", opinion: { verdict: "unclear", reason: "depends on files not shown" } }), finding({ opinion: { verdict: "upheld" } })], verification: { by: "muse/m", checked: 2, refuted: 0, undecided: 1 } },
      false,
    );
    assert.match(kept, /second reviewer: unclear: depends on files not shown/);
    assert.match(kept, /second reviewer: upheld\n/);
    assert.match(text, /graded lower than the reviewer first said, because they were not proven or were refuted/);
    assert.doesNotMatch(formatReview(base, false), /checked by/);
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
