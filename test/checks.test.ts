import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileChange, ReviewComment } from "../src/bitbucket.ts";
import {
  changedPaths,
  checkAuthorHistory,
  checkExclusions,
  checkReviewFindings,
  checkServices,
  checkSize,
} from "../src/checks.ts";
import { NO_EXCLUSIONS, parseExclusions } from "../src/patterns.ts";

const change = (path: string, added: number, removed = 0): FileChange => ({
  oldPath: path,
  newPath: path,
  linesAdded: added,
  linesRemoved: removed,
});

describe("changedPaths", () => {
  it("lists both sides of a rename once, sorted", () => {
    const paths = changedPaths([
      { oldPath: "b/old.ts", newPath: "a/new.ts", linesAdded: 1, linesRemoved: 1 },
      { newPath: "c/added.ts", linesAdded: 1, linesRemoved: 0 },
      { oldPath: "d/removed.ts", linesAdded: 0, linesRemoved: 1 },
      change("a/new.ts", 1),
    ]);
    assert.deepEqual(paths, ["a/new.ts", "b/old.ts", "c/added.ts", "d/removed.ts"]);
  });
});

describe("checkSize", () => {
  it("passes below the limit and counts added plus removed lines", () => {
    assert.equal(checkSize([change("a", 400, 599)], 1000).status, "pass");
  });

  it("fails at exactly the limit", () => {
    const check = checkSize([change("a", 500, 500)], 1000);
    assert.equal(check.status, "fail");
    assert.match(check.summary, /^1000 lines changed \(must be fewer than 1000\)$/);
  });

  it("adds up several files", () => {
    assert.equal(checkSize([change("a", 600), change("b", 400)], 1000).status, "fail");
  });
});

describe("checkServices", () => {
  it("passes with fewer services than the limit", () => {
    assert.equal(checkServices(["a", "b"], 3).status, "pass");
  });

  it("fails at the limit and lists the services", () => {
    const check = checkServices(["a", "b", "c"], 3);
    assert.equal(check.status, "fail");
    assert.deepEqual(check.details, ["a", "b", "c"]);
  });

  it("with a limit of 1, passes only when no service is affected", () => {
    assert.equal(checkServices([], 1).status, "pass");
    assert.equal(checkServices(["a"], 1).status, "fail");
  });
});

describe("checkExclusions", () => {
  const matcher = parseExclusions("libs/shared/\npayments/");

  it("passes when no changed path matches", () => {
    assert.equal(checkExclusions(["apps/web/a.ts"], matcher, true).status, "pass");
  });

  it("fails and names the path and the pattern", () => {
    const check = checkExclusions(["apps/web/a.ts", "libs/shared/b.ts"], matcher, true);
    assert.equal(check.status, "fail");
    assert.deepEqual(check.details, ['libs/shared/b.ts (excluded by "libs/shared/")']);
  });

  it("fails when the PR changes the exclusion file itself", () => {
    const check = checkExclusions([".small_change"], NO_EXCLUSIONS, true);
    assert.equal(check.status, "fail");
    assert.match(check.details.join(), /the exclusion file itself/);
  });

  it("notes that nothing is excluded when the file is missing", () => {
    const check = checkExclusions(["a.ts"], NO_EXCLUSIONS, false);
    assert.equal(check.status, "pass");
    assert.match(check.details.join(), /no \.small_change file/);
  });
});

describe("checkReviewFindings", () => {
  const person = (name: string, uuid = `{${name}}`) => ({ uuid, name });
  const comment = (id: number, name: string, body: string, resolved = false): ReviewComment => ({
    id,
    author: person(name),
    body,
    resolved,
  });
  const pattern = /\bP[12]\b/i;

  it("passes without matching comments", () => {
    const check = checkReviewFindings([comment(1, "bot", "P3: nit"), comment(2, "bot", "looks good")], {
      bots: [],
      pattern,
    });
    assert.equal(check.status, "pass");
  });

  it("fails on an unresolved P1 or P2, quoting the matching line", () => {
    const check = checkReviewFindings([comment(7, "bot", "Summary\n**P1** Null deref in handler")], {
      bots: [],
      pattern,
    });
    assert.equal(check.status, "fail");
    assert.deepEqual(check.details, ["#7 bot: **P1** Null deref in handler"]);
  });

  it("matches case-insensitively and only as a whole word", () => {
    assert.equal(checkReviewFindings([comment(1, "bot", "p2 issue")], { bots: [], pattern }).status, "fail");
    assert.equal(checkReviewFindings([comment(1, "bot", "step P10 and TP1x")], { bots: [], pattern }).status, "pass");
  });

  it("ignores a resolved finding", () => {
    assert.equal(
      checkReviewFindings([comment(1, "bot", "P1 bug", true)], { bots: [], pattern }).status,
      "pass",
    );
  });

  it("reads only the named bots, by name, nickname or UUID, ignoring braces and case", () => {
    const comments: ReviewComment[] = [
      { id: 1, author: { uuid: "{abc-123}", name: "Review Bot" }, body: "P1 here", resolved: false },
      { id: 2, author: { uuid: "{human}", name: "Alice", nickname: "alice" }, body: "P2 here", resolved: false },
    ];
    assert.equal(checkReviewFindings(comments, { bots: ["alice"], pattern }).details.length, 1);
    assert.equal(checkReviewFindings(comments, { bots: ["review bot"], pattern }).details[0]?.startsWith("#1"), true);
    assert.equal(checkReviewFindings(comments, { bots: ["ABC-123"], pattern }).details[0]?.startsWith("#1"), true);
    assert.equal(checkReviewFindings(comments, { bots: ["someone-else"], pattern }).status, "pass");
  });
});

describe("checkAuthorHistory", () => {
  async function* ids(...values: number[]) {
    yield* values;
  }
  const history = (byPr: Record<number, string[]>, prIds: number[], overrides = {}) => {
    const read: number[] = [];
    const input = {
      services: ["svc/a"],
      minMerged: 2,
      scanLimit: 100,
      serviceDepth: 2,
      mergedPullRequestIds: ids(...prIds),
      pathsOf: async (id: number) => {
        read.push(id);
        return byPr[id] ?? [];
      },
      ...overrides,
    };
    return { input, read };
  };

  it("passes once every affected service has enough merged PRs, and stops reading", async () => {
    const { input, read } = history({ 1: ["svc/a/x.ts"], 2: ["svc/a/y.ts"], 3: ["svc/a/z.ts"] }, [1, 2, 3]);
    const check = await checkAuthorHistory(input);
    assert.equal(check.status, "pass");
    assert.deepEqual(read, [1, 2]);
    assert.deepEqual(check.details, ["svc/a: 2/2"]);
  });

  it("counts a PR for each affected service it touches, and ignores other services", async () => {
    const { input } = history(
      { 1: ["svc/a/x.ts", "svc/b/x.ts"], 2: ["svc/b/y.ts"], 3: ["svc/a/z.ts"] },
      [1, 2, 3],
      { services: ["svc/a", "svc/b"] },
    );
    const check = await checkAuthorHistory(input);
    assert.equal(check.status, "pass");
    assert.deepEqual(check.details, ["svc/a: 2/2", "svc/b: 2/2"]);
  });

  it("fails when one service lacks history and says how many PRs it read", async () => {
    const { input } = history({ 1: ["svc/a/x.ts"], 2: ["svc/a/y.ts"] }, [1, 2], {
      services: ["svc/a", "svc/b"],
    });
    const check = await checkAuthorHistory(input);
    assert.equal(check.status, "fail");
    assert.match(check.summary, /lacks 2 merged PRs in 1 of 2/);
    assert.deepEqual(check.details, ["svc/a: 2/2", "svc/b: 0/2", "read all 2 merged PR(s) of the author"]);
  });

  it("stops at the scan limit", async () => {
    const { input, read } = history({}, [1, 2, 3, 4], { scanLimit: 2 });
    const check = await checkAuthorHistory(input);
    assert.equal(check.status, "fail");
    assert.deepEqual(read, [1, 2]);
    assert.match(check.details.at(-1) ?? "", /stopped after reading 2 merged PRs/);
  });

  it("passes when no service is affected", async () => {
    const { input, read } = history({}, [1], { services: [] });
    assert.equal((await checkAuthorHistory(input)).status, "pass");
    assert.deepEqual(read, []);
  });
});
