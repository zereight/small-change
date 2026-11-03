import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatComment, headline } from "../src/review/comment.ts";
import { FindingsError, parseFindings } from "../src/review/findings.ts";
import { buildPrompt } from "../src/review/prompt.ts";

const finding = (severity: string, title: string, extra: object = {}) => ({ severity, title, detail: "d", ...extra });

describe("parseFindings", () => {
  it("reads a findings object", () => {
    const answer = JSON.stringify({ findings: [finding("P1", "Bug", { path: "a.ts", line: 4 })] });
    const parsed = parseFindings(answer, 10);
    assert.deepEqual(parsed.findings, [{ severity: "P1", title: "Bug", detail: "d", path: "a.ts", line: 4 }]);
    assert.equal(parsed.dropped, 0);
  });

  it("reads a bare array, a fenced block and JSON after prose", () => {
    const list = JSON.stringify([finding("P2", "x")]);
    assert.equal(parseFindings(list, 10).findings.length, 1);
    assert.equal(parseFindings("```json\n" + JSON.stringify({ findings: [finding("P2", "x")] }) + "\n```", 10).findings.length, 1);
    assert.equal(parseFindings("Here you go: " + JSON.stringify({ findings: [finding("P3", "y")] }) + " Thanks", 10).findings.length, 1);
  });

  it("accepts an empty list", () => {
    assert.deepEqual(parseFindings('{"findings":[]}', 10), { findings: [], dropped: 0, omitted: 0 });
  });

  it("throws when the answer is not JSON or has no list", () => {
    assert.throws(() => parseFindings("looks fine to me", 10), FindingsError);
    assert.throws(() => parseFindings('{"result":"ok"}', 10), /no "findings" list/);
    assert.throws(() => parseFindings("", 10), /\(empty\)/);
  });

  it("drops entries that are not findings and counts them", () => {
    const answer = JSON.stringify({ findings: [finding("P1", "ok"), finding("P9", "bad level"), finding("P2", ""), "text", null, { severity: "P1" }] });
    const parsed = parseFindings(answer, 10);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.dropped, 5);
  });

  it("normalizes the severity's case", () => {
    assert.equal(parseFindings(JSON.stringify([finding(" p1 ", "x")]), 10).findings[0]?.severity, "P1");
  });

  it("sorts by severity, keeping the model's order within one, and applies the limit", () => {
    const answer = JSON.stringify([finding("P3", "c"), finding("P1", "a"), finding("P2", "b"), finding("P1", "a2")]);
    const parsed = parseFindings(answer, 3);
    assert.deepEqual(parsed.findings.map((f) => f.title), ["a", "a2", "b"]);
    assert.equal(parsed.omitted, 1);
  });

  it("drops duplicates", () => {
    const parsed = parseFindings(JSON.stringify([finding("P1", "same", { path: "a", line: 1 }), finding("P1", "same", { path: "a", line: 1 })]), 10);
    assert.equal(parsed.findings.length, 1);
  });

  it("ignores bad paths and lines but keeps the finding", () => {
    const parsed = parseFindings(JSON.stringify([finding("P1", "x", { path: "a\nb", line: -3 }), finding("P2", "y", { path: 5, line: 1.5 })]), 10);
    assert.deepEqual(parsed.findings.map((f) => [f.path, f.line]), [[undefined, undefined], [undefined, undefined]]);
  });

  it("clips a long title and collapses its whitespace", () => {
    const title = parseFindings(JSON.stringify([finding("P1", `a\n\n  b ${"x".repeat(500)}`)]), 10).findings[0]?.title ?? "";
    assert.ok(title.length <= 120);
    assert.ok(!title.includes("\n"));
    assert.ok(title.startsWith("a b x"));
  });
});

describe("comment", () => {
  it("starts with the severity so small-change's default pattern counts it", () => {
    const text = formatComment({ severity: "P2", title: "Null deref", detail: "Fix it", path: "src/a.ts", line: 9 }, "small-change review");
    assert.match(text.split("\n")[0] as string, /\bP[12]\b/);
    assert.equal(text.split("\n")[0], "**P2** Null deref");
    assert.ok(text.includes("`src/a.ts:9`"));
    assert.ok(text.endsWith("_small-change review_"));
  });

  it("neutralizes mentions and images that the PR's text could have steered into the answer", () => {
    const text = formatComment(
      { severity: "P1", title: "ping @alice", detail: "see ![x](https://evil.example/?q=1) and @{uuid-1234}" },
      "f",
    );
    assert.ok(!/@\w/.test(text) && !text.includes("@{"));
    assert.ok(!text.includes("![x]"));
  });

  it("gives the same headline to the same finding, for skipping a repeat", () => {
    const a = { severity: "P1", title: "Same @bob", detail: "one" } as const;
    const b = { severity: "P1", title: "Same @bob", detail: "two" } as const;
    assert.equal(headline(a), headline(b));
    assert.equal(formatComment(a, "f").split("\n")[0], headline(a));
  });
});

describe("buildPrompt", () => {
  const input = { title: "T", description: "D", diff: "diff --git a b", language: "Korean", maxFindings: 7, nonce: "n0nce" };

  it("fences the PR text with the nonce and says it is data", () => {
    const prompt = buildPrompt(input);
    assert.ok(prompt.includes("=== BEGIN PULL REQUEST n0nce ==="));
    assert.ok(prompt.includes("=== END PULL REQUEST n0nce ==="));
    assert.ok(prompt.indexOf("diff --git a b") > prompt.indexOf("BEGIN PULL REQUEST"));
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /in Korean/);
    assert.match(prompt, /at most 7 findings/);
  });

  it("picks another marker when the PR's text contains the nonce", () => {
    const prompt = buildPrompt({ ...input, description: "n0nce n0nce" });
    assert.ok(!prompt.includes("BEGIN PULL REQUEST n0nce"));
  });

  it("uses a random marker by default, different per call", () => {
    const { nonce: _ignored, ...rest } = input;
    const marker = (text: string) => /BEGIN PULL REQUEST (\w+)/.exec(text)?.[1];
    assert.notEqual(marker(buildPrompt(rest)), marker(buildPrompt(rest)));
  });
});
