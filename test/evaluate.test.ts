import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bitbucket, FileChange, ReviewComment } from "../src/bitbucket.ts";
import { evaluate, type Options } from "../src/evaluate.ts";
import { formatReport } from "../src/report.ts";

const REF = { workspace: "team", repo: "repo", id: 100 };
const OPTIONS: Options = {
  maxLines: 1000,
  maxServices: 3,
  minMergedPullRequests: 2,
  serviceDepth: 2,
  bots: [],
  findingPattern: /\bP[12]\b/i,
  historyScanLimit: 100,
};

const edit = (path: string, added = 10): FileChange => ({
  oldPath: path,
  newPath: path,
  linesAdded: added,
  linesRemoved: 0,
});

interface World {
  changes?: FileChange[];
  comments?: ReviewComment[];
  exclusionFile?: string;
  /** The author's merged PRs by id, newest first, each with the files it changed. */
  history?: Record<number, FileChange[]>;
}

/** An in-memory Bitbucket that records what was read. */
function fakeBitbucket(world: World) {
  const calls: string[] = [];
  const history = world.history ?? {};
  const bitbucket: Bitbucket = {
    async getPullRequest() {
      calls.push("pr");
      return {
        id: REF.id,
        title: "Change",
        description: "",
        author: { uuid: "{author}", name: "Alice" },
        sourceCommit: "src123",
        destinationCommit: "dest123",
      };
    },
    async getFileChanges(ref) {
      calls.push(`changes:${ref.id}`);
      return ref.id === REF.id ? (world.changes ?? []) : (history[ref.id] ?? []);
    },
    async getComments() {
      calls.push("comments");
      return world.comments ?? [];
    },
    async *listMergedPullRequestIds(_repository, authorUuid) {
      calls.push(`merged:${authorUuid}`);
      for (const id of Object.keys(history).map(Number)) {
        yield id;
      }
    },
    async getFile(_repository, commit, path) {
      calls.push(`file:${commit}:${path}`);
      return world.exclusionFile;
    },
  };
  return { bitbucket, calls };
}

const status = (report: Awaited<ReturnType<typeof evaluate>>) =>
  Object.fromEntries(report.results.map((check) => [check.name, check.status]));

describe("evaluate", () => {
  it("accepts a small change by an experienced author", async () => {
    const { bitbucket } = fakeBitbucket({
      changes: [edit("apps/web/a.ts")],
      history: { 1: [edit("apps/web/x.ts")], 2: [edit("apps/web/y.ts")] },
    });

    const report = await evaluate(bitbucket, REF, OPTIONS);

    assert.equal(report.eligible, true);
    assert.deepEqual(status(report), {
      size: "pass",
      "review-findings": "pass",
      "author-history": "pass",
      services: "pass",
      exclusions: "pass",
    });
  });

  it("reads the exclusion file from the destination commit and the author's history by uuid", async () => {
    const { bitbucket, calls } = fakeBitbucket({ changes: [edit("apps/web/a.ts")] });

    await evaluate(bitbucket, REF, OPTIONS);

    assert.ok(calls.includes("file:dest123:.small_change"));
    assert.ok(calls.includes("merged:{author}"));
  });

  it("rejects a change that reaches 1000 lines", async () => {
    const { bitbucket } = fakeBitbucket({ changes: [edit("apps/web/a.ts", 1000)] });
    assert.equal(status(await evaluate(bitbucket, REF, OPTIONS)).size, "fail");
  });

  it("rejects a change that affects as many services as the limit", async () => {
    const { bitbucket } = fakeBitbucket({
      changes: [edit("apps/a/x.ts"), edit("apps/b/x.ts"), edit("apps/c/x.ts")],
    });
    const report = await evaluate(bitbucket, REF, OPTIONS);
    assert.equal(status(report).services, "fail");
    assert.equal(report.eligible, false);
  });

  it("rejects an unresolved P1 finding", async () => {
    const { bitbucket } = fakeBitbucket({
      changes: [edit("apps/web/a.ts")],
      comments: [{ id: 1, author: { uuid: "{bot}", name: "bot" }, body: "P1: bug", resolved: false }],
    });
    assert.equal(status(await evaluate(bitbucket, REF, OPTIONS))["review-findings"], "fail");
  });

  it("rejects a path that the exclusion file lists, and a change to the exclusion file", async () => {
    const world = { exclusionFile: "libs/shared/\n" };
    const shared = fakeBitbucket({ ...world, changes: [edit("libs/shared/a.ts")] });
    assert.equal(status(await evaluate(shared.bitbucket, REF, OPTIONS)).exclusions, "fail");

    const own = fakeBitbucket({ ...world, changes: [edit(".small_change")] });
    assert.equal(status(await evaluate(own.bitbucket, REF, OPTIONS)).exclusions, "fail");
  });

  it("rejects an author without enough merged PRs in the affected service", async () => {
    const { bitbucket } = fakeBitbucket({
      changes: [edit("apps/web/a.ts")],
      history: { 1: [edit("apps/web/x.ts")], 2: [edit("apps/admin/y.ts")] },
    });
    const report = await evaluate(bitbucket, REF, OPTIONS);
    assert.equal(status(report)["author-history"], "fail");
    assert.equal(report.eligible, false);
  });

  it("skips the costly history check when another check already failed", async () => {
    const { bitbucket, calls } = fakeBitbucket({ changes: [edit("apps/web/a.ts", 5000)] });

    const report = await evaluate(bitbucket, REF, OPTIONS);

    assert.equal(status(report)["author-history"], "skip");
    assert.ok(!calls.some((call) => call.startsWith("merged:")));
    assert.equal(report.eligible, false);
  });

  it("fails on an exclusion file it cannot parse instead of ignoring it", async () => {
    const { bitbucket } = fakeBitbucket({ changes: [edit("a/b/c.ts")], exclusionFile: "!keep/\n" });
    await assert.rejects(evaluate(bitbucket, REF, OPTIONS), /negation/);
  });
});

describe("formatReport", () => {
  it("prints one line per check, the details below it and the verdict", async () => {
    const { bitbucket } = fakeBitbucket({
      changes: [edit("apps/a/x.ts"), edit("apps/b/x.ts"), edit("apps/c/x.ts")],
    });

    const text = formatReport(await evaluate(bitbucket, REF, OPTIONS));

    assert.match(text, /^team\/repo#100 "Change" by Alice\n/);
    assert.match(text, /PASS {2}size {13}30 lines changed \(must be fewer than 1000\)/);
    assert.match(text, /FAIL {2}services {9}3 affected service\(s\) \(must be fewer than 3\)\n {6}- apps\/a\n/);
    assert.match(text, /SKIP {2}author-history {3}not checked: another check already failed/);
    assert.match(text, /\nResult: not a small change$/);
  });
});
