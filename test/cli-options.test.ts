import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModelArgs } from "../src/model-options.ts";
import { UsageError } from "../src/options.ts";
import { parseReviewArgs } from "../src/review-options.ts";

const URL = "https://bitbucket.org/team/repo/pull-requests/12";

describe("parseModelArgs", () => {
  it("parses setup flags, with verification on by default", () => {
    assert.deepEqual(parseModelArgs(["setup", "--provider", "cursor", "--model", "auto", "--budget", "medium", "--yes"]), {
      command: "setup", provider: "cursor", model: "auto", budget: "medium", role: "reviewer", remove: false, yes: true, verify: true, config: undefined,
    });
  });

  it("turns verification off with --no-verify", () => {
    const parsed = parseModelArgs(["setup", "--no-verify"]);
    assert.equal(parsed.command === "setup" && parsed.verify, false);
  });

  it("parses the verifier role and --remove", () => {
    const verifier = parseModelArgs(["setup", "--role", "verifier", "--provider", "muse", "--model", "muse-spark-1.3", "--budget", "medium"]);
    assert.ok(verifier.command === "setup");
    assert.equal(verifier.role, "verifier");
    assert.equal(verifier.remove, false);
    const removal = parseModelArgs(["setup", "--role", "verifier", "--remove"]);
    assert.ok(removal.command === "setup");
    assert.equal(removal.remove, true);
  });

  it("rejects a bad role and a misplaced --remove", () => {
    assert.throws(() => parseModelArgs(["setup", "--role", "judge"]), /Invalid --role "judge": expected reviewer or verifier/);
    assert.throws(() => parseModelArgs(["setup", "--remove"]), /--remove applies to the verifier only/);
    assert.throws(() => parseModelArgs(["setup", "--role", "reviewer", "--remove"]), /--remove applies to the verifier only/);
    assert.throws(() => parseModelArgs(["setup", "--role", "verifier", "--remove", "--model", "x"]), /cannot be combined/);
  });

  it("accepts pi and muse as providers", () => {
    assert.deepEqual(parseModelArgs(["list", "--provider", "pi"]), { command: "list", provider: "pi" });
    assert.deepEqual(parseModelArgs(["list", "--provider", "muse"]), { command: "list", provider: "muse" });
  });

  it("parses show and list", () => {
    assert.deepEqual(parseModelArgs(["show", "--config", "/c.json"]), { command: "show", config: "/c.json" });
    assert.deepEqual(parseModelArgs(["list", "--provider", "codex"]), { command: "list", provider: "codex" });
  });

  it("rejects bad input", () => {
    assert.throws(() => parseModelArgs([]), UsageError);
    assert.throws(() => parseModelArgs(["wat"]), /Unknown command "wat"/);
    assert.throws(() => parseModelArgs(["setup", "--provider", "gemini"]), /Invalid --provider "gemini": expected one of claude, cursor, codex, pi, muse/);
    assert.throws(() => parseModelArgs(["setup", "--budget", "huge"]), /Invalid --budget/);
    assert.throws(() => parseModelArgs(["setup", "extra"]), /Unexpected extra/);
    assert.throws(() => parseModelArgs(["setup", "--bogus"]), UsageError);
  });

  it("answers --help", () => {
    assert.deepEqual(parseModelArgs(["--help"]), { command: "help" });
  });
});

describe("parseReviewArgs", () => {
  it("applies the defaults", () => {
    const parsed = parseReviewArgs([URL]);
    assert.deepEqual(parsed, {
      command: "review",
      ref: { workspace: "team", repo: "repo", id: 12 },
      config: undefined,
      options: { post: false, verifier: true, language: "English", maxFindings: 10, maxDiffBytes: 300_000, contextBytes: 120_000, contextLines: 40, timeoutMs: 900_000 },
    });
  });

  it("parses the flags", () => {
    const parsed = parseReviewArgs([URL, "--post", "--language", "Korean", "--max-findings", "3", "--max-diff-bytes", "5000", "--context-bytes", "0", "--context-lines", "10", "--timeout", "60", "--config", "/c"]);
    assert.ok(parsed.command === "review");
    assert.deepEqual(parsed.options, { post: true, verifier: true, language: "Korean", maxFindings: 3, maxDiffBytes: 5000, contextBytes: 0, contextLines: 10, timeoutMs: 60_000 });
    assert.equal(parsed.config, "/c");
  });

  it("turns the verifier off with --no-verifier", () => {
    const parsed = parseReviewArgs([URL, "--no-verifier"]);
    assert.ok(parsed.command === "review");
    assert.equal(parsed.options.verifier, false);
  });

  it("rejects bad input", () => {
    assert.throws(() => parseReviewArgs([]), /Missing required argument/);
    assert.throws(() => parseReviewArgs(["https://example.com/x"]), /Invalid PR URL/);
    assert.throws(() => parseReviewArgs([URL, "--max-findings", "0"]), /positive integer/);
    assert.throws(() => parseReviewArgs([URL, "--context-lines", "0"]), /positive integer/);
    assert.throws(() => parseReviewArgs([URL, "--context-bytes=-1"]), /non-negative integer/);
    assert.throws(() => parseReviewArgs([URL, "--context-bytes", "1.5"]), /non-negative integer/);
    assert.throws(() => parseReviewArgs([URL, "--language", "a\nb"]), /Invalid --language/);
    assert.throws(() => parseReviewArgs([URL, "--language", ""]), /Invalid --language/);
    assert.throws(() => parseReviewArgs([URL, URL]), /Unexpected extra/);
  });
});
