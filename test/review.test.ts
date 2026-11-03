import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BitbucketReview, ReviewComment } from "../src/bitbucket.ts";
import type { Exec, Provider, RunRequest } from "../src/llm/types.ts";
import type { ModelConfig } from "../src/model-config.ts";
import { formatReview, type ReviewOptions, runReview } from "../src/review/review.ts";

const REF = { workspace: "team", repo: "repo", id: 5 };
const CONFIG: ModelConfig = { version: 1, provider: "claude", model: "opus", budget: "large", effort: "xhigh" };
const OPTIONS: ReviewOptions = { maxFindings: 10, maxDiffBytes: 1000, language: "English", post: true, timeoutMs: 1000 };
const NO_EXEC: Exec = async () => assert.fail("exec must not be called directly");

interface World {
  diff?: string;
  description?: string;
  comments?: string[];
  answer?: string;
  failPostAt?: number;
}

function setup(world: World) {
  const posted: string[] = [];
  const requests: RunRequest[] = [];
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
      return world.diff ?? "diff --git a/x b/x\n+line\n";
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
    async getFileChanges() {
      return assert.fail("not used");
    },
    async *listMergedPullRequestIds() {
      assert.fail("not used");
    },
    async getFile() {
      return assert.fail("not used");
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
  return { bitbucket, provider, posted, requests, deps: { bitbucket, provider, exec: NO_EXEC, config: CONFIG, env } };
}

const answer = (...findings: object[]) => JSON.stringify({ findings });

describe("runReview", () => {
  it("gives the agent the diff in an empty directory, with no Bitbucket variable, and the configured model", async () => {
    const world = setup({ answer: answer() });
    await runReview(world.deps, REF, OPTIONS);
    const [request] = world.requests;
    assert.ok(request?.prompt.includes("diff --git a/x b/x"));
    assert.equal(request?.model, "opus");
    assert.equal(request?.effort, "xhigh");
    assert.equal(request?.timeoutMs, 1000);
    assert.deepEqual(request?.env, { PATH: "/bin" });
    assert.match(request?.workdir ?? "", /small-change-review-/);
  });

  it("posts each finding as a comment with the reviewer and commit in the footer", async () => {
    const world = setup({ answer: answer({ severity: "P1", title: "Bug", detail: "bad", path: "x", line: 2 }, { severity: "P3", title: "Nit", detail: "" }) });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.equal(result.posted.length, 2);
    assert.equal(result.reviewer, "claude/opus");
    assert.equal(world.posted[0]?.split("\n")[0], "**P1** Bug");
    assert.match(world.posted[0] ?? "", /small-change review · claude\/opus · commit abc123def456/);
  });

  it("does not post without --post", async () => {
    const world = setup({ answer: answer({ severity: "P1", title: "Bug", detail: "" }) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, post: false });
    assert.equal(result.findings.length, 1);
    assert.deepEqual(world.posted, []);
  });

  it("skips a finding whose headline an existing comment already opens with", async () => {
    const world = setup({
      comments: ["**P1** Bug\n\nold detail", "unrelated"],
      answer: answer({ severity: "P1", title: "Bug", detail: "" }, { severity: "P2", title: "New one", detail: "" }),
    });
    const result = await runReview(world.deps, REF, OPTIONS);
    assert.deepEqual(world.posted.map((body) => body.split("\n")[0]), ["**P2** New one"]);
    assert.equal(result.alreadyPosted.length, 1);
  });

  it("reports how many comments went out when a post fails", async () => {
    const world = setup({
      failPostAt: 1,
      answer: answer({ severity: "P1", title: "a", detail: "" }, { severity: "P2", title: "b", detail: "" }),
    });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /Posted 1 of 2 comments before failing: 403 forbidden/);
  });

  it("refuses a diff over the limit instead of reviewing part of it, and never calls the agent", async () => {
    const world = setup({ diff: "x".repeat(1001) });
    await assert.rejects(runReview(world.deps, REF, OPTIONS), /over the limit of 1000/);
    assert.equal(world.requests.length, 0);
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
    const findings = [1, 2, 3].map((n) => ({ severity: "P2", title: `t${n}`, detail: "" }));
    const world = setup({ answer: answer(...findings) });
    const result = await runReview(world.deps, REF, { ...OPTIONS, maxFindings: 2 });
    assert.equal(result.findings.length, 2);
    assert.equal(result.omitted, 1);
  });
});

describe("formatReview", () => {
  const base = { pullRequest: { ref: REF, title: "Add thing", sourceCommit: "abc" }, reviewer: "claude/opus", dropped: 0, omitted: 0, posted: [], alreadyPosted: [] };

  it("says there were no findings", () => {
    const text = formatReview({ ...base, findings: [] }, true);
    assert.match(text, /team\/repo#5 "Add thing"/);
    assert.match(text, /No findings\./);
    assert.ok(!text.includes("Posted"));
  });

  it("lists findings, counts them and points to --post when not posting", () => {
    const findings = [{ severity: "P1", title: "Bug", detail: "line one\nline two", path: "a.ts", line: 3 }, { severity: "P3", title: "Nit", detail: "" }] as const;
    const text = formatReview({ ...base, findings: [...findings] }, false);
    assert.match(text, /P1 a\.ts:3  Bug/);
    assert.match(text, /2 finding\(s\): 1 P1, 1 P3\./);
    assert.match(text, /Not posted\. Run again with --post/);
  });

  it("reports posted, skipped, omitted and dropped counts", () => {
    const finding = { severity: "P2", title: "x", detail: "" } as const;
    const text = formatReview({ ...base, findings: [finding], posted: [{ finding, commentId: 1 }], alreadyPosted: [finding], omitted: 2, dropped: 1 }, true);
    assert.match(text, /Posted 1 comment\(s\)\./);
    assert.match(text, /1 already had a comment/);
    assert.match(text, /2 more finding\(s\) were left out/);
    assert.match(text, /1 entry\(ies\) of the answer were not findings/);
  });
});
