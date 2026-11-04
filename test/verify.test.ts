import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatComment } from "../src/review/comment.ts";
import { parseDiff } from "../src/review/diff.ts";
import { type Finding, FindingsError } from "../src/review/findings.ts";
import { buildQuoteChecker } from "../src/review/material.ts";
import { applyVerdict, buildVerifyPrompt, bySeverity, isBlocking, parseVerdicts } from "../src/review/verify.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,4 @@
 const items = load();
+// The next login sends the token again, so a failure here is fine.
+const token = await lookup().catch(() => null);
+send(token);
`;
const check = buildQuoteChecker(parseDiff(DIFF), []);

const finding = (extra: Partial<Finding> = {}): Finding => ({
  severity: "P2",
  title: "Failure sent as no token",
  detail: "A failed lookup is sent as null.",
  basis: "code",
  path: "src/a.ts",
  line: 3,
  condition: "lookup rejects",
  evidence: [{ path: "src/a.ts", line: 3, quote: "const token = await lookup().catch(() => null);" }],
  ...extra,
});

const COUNTER = { path: "src/a.ts", line: 2, quote: "// The next login sends the token again, so a failure here is fine." };
const answer = (...verdicts: unknown[]) => JSON.stringify({ verdicts });

describe("isBlocking", () => {
  it("is true for the grades the check counts", () => {
    assert.deepEqual((["P1", "P2", "P3", "ASK"] as const).map((severity) => isBlocking(finding({ severity }))), [true, true, false, false]);
  });
});

describe("parseVerdicts", () => {
  const candidates = [finding(), finding({ severity: "P1", title: "Second" })];

  it("reads a verdict for each candidate by its number", () => {
    const verdicts = parseVerdicts(
      answer(
        { id: 2, verdict: "upheld", reason: "no guard" },
        { id: 1, verdict: "refuted", reason: "the comment says it is deliberate.", counter: COUNTER },
      ),
      candidates,
      check,
    );
    assert.deepEqual(verdicts[0], { verdict: "refuted", reason: "the comment says it is deliberate", counter: COUNTER });
    assert.deepEqual(verdicts[1], { verdict: "upheld", reason: "no guard" });
  });

  it("reads a bare list, a fenced block and JSON after prose", () => {
    const entry = { id: 1, verdict: "upheld" };
    assert.equal(parseVerdicts(JSON.stringify([entry]), candidates, check)[0]?.verdict, "upheld");
    assert.equal(parseVerdicts(`\`\`\`json\n${answer(entry)}\n\`\`\``, candidates, check)[0]?.verdict, "upheld");
    assert.equal(parseVerdicts(`Done. ${answer(entry)}`, candidates, check)[0]?.verdict, "upheld");
  });

  it("counts a refutation without a quote found in the code shown as unclear", () => {
    const fake = parseVerdicts(answer({ id: 1, verdict: "refuted", reason: "it is handled", counter: { path: "src/a.ts", quote: "if (isHandledSomewhere(token)) return;" } }), candidates, check);
    assert.equal(fake[0]?.verdict, "unclear");
    assert.match(fake[0]?.reason ?? "", /without a quote found in the code shown \(it is handled\)/);
    assert.equal(fake[0]?.counter, undefined);

    const none = parseVerdicts(answer({ id: 1, verdict: "refuted", reason: "it is handled" }), candidates, check);
    assert.equal(none[0]?.verdict, "unclear");
  });

  it("counts a refutation without a reason as unclear", () => {
    const verdicts = parseVerdicts(answer({ id: 1, verdict: "refuted", counter: COUNTER }), candidates, check);
    assert.deepEqual(verdicts[0], { verdict: "unclear", reason: "it was refuted without a reason" });
  });

  it("takes a counter quote with no path as one in the finding's file, and one in another file as not found", () => {
    const bare = parseVerdicts(answer({ id: 1, verdict: "refuted", reason: "r", counter: COUNTER.quote }), candidates, check);
    assert.equal(bare[0]?.verdict, "refuted");
    const other = parseVerdicts(answer({ id: 1, verdict: "refuted", reason: "r", counter: { path: "src/b.ts", quote: COUNTER.quote } }), candidates, check);
    assert.equal(other[0]?.verdict, "unclear");
  });

  it("leaves a candidate with no usable verdict undefined, and ignores unknown ids, verdicts and repeats", () => {
    const verdicts = parseVerdicts(
      answer(
        { id: 7, verdict: "refuted", reason: "r", counter: COUNTER },
        { id: 1, verdict: "maybe" },
        { id: "1", verdict: "upheld" },
        "text",
        null,
        { id: 2, verdict: " Upheld " },
        { id: 2, verdict: "refuted", reason: "r", counter: COUNTER },
      ),
      candidates,
      check,
    );
    assert.deepEqual(verdicts, [undefined, { verdict: "upheld" }]);
  });

  it("clips and flattens a long reason", () => {
    const [verdict] = parseVerdicts(answer({ id: 1, verdict: "upheld", reason: `a\n\n b ${"x".repeat(900)}` }), candidates, check);
    assert.ok((verdict?.reason?.length ?? 0) <= 500 && !verdict?.reason?.includes("\n"));
  });

  it("throws when the answer is not JSON or has no list of verdicts", () => {
    assert.throws(() => parseVerdicts("all fine", candidates, check), FindingsError);
    assert.throws(() => parseVerdicts('{"findings":[]}', candidates, check), /no "verdicts" list/);
    assert.throws(() => parseVerdicts("", candidates, check), /\(empty\)/);
  });
});

describe("applyVerdict", () => {
  const refuted = { verdict: "refuted", reason: "the comment says it is deliberate", counter: COUNTER } as const;

  it("lowers a refuted P1 or P2 to P3 with the reviewer's name and the counter quote", () => {
    for (const severity of ["P1", "P2"] as const) {
      const lowered = applyVerdict(finding({ severity }), refuted, "muse/muse-spark-1.3");
      assert.equal(lowered.severity, "P3");
      assert.deepEqual(lowered.lowered, { from: severity, reason: "the second reviewer (muse/muse-spark-1.3) refuted it: the comment says it is deliberate" });
      assert.deepEqual(lowered.counter, COUNTER);
    }
  });

  it("keeps a finding that was upheld, unclear, or not answered, and records what the verifier said", () => {
    const original = finding();
    assert.deepEqual(applyVerdict(original, { verdict: "upheld" }, "x"), { ...original, opinion: { verdict: "upheld" } });
    assert.deepEqual(applyVerdict(original, { verdict: "unclear", reason: "r" }, "x"), { ...original, opinion: { verdict: "unclear", reason: "r" } });
    assert.deepEqual(applyVerdict(original, undefined, "x").opinion, { verdict: "unclear", reason: "the verifier gave no verdict for it" });
    assert.equal(applyVerdict(original, { verdict: "upheld" }, "x").severity, "P2");
  });

  it("leaves a finding that is not P1 or P2 untouched", () => {
    const nit = finding({ severity: "P3" });
    assert.equal(applyVerdict(nit, refuted, "x"), nit);
    const question = finding({ severity: "ASK" });
    assert.equal(applyVerdict(question, undefined, "x"), question);
  });

  it("records the refutation as the opinion too", () => {
    assert.deepEqual(applyVerdict(finding(), refuted, "x").opinion, { verdict: "refuted", reason: "the comment says it is deliberate" });
  });

  it("is not in the comment, which has only the grade, title, place, condition and evidence", () => {
    const text = formatComment(applyVerdict(finding(), { ...refuted, reason: "see @alice ![x](https://evil.example/)" }, "muse/m"), ["English"]);
    assert.equal(text.split("\n")[0], "**P3** Failure sent as no token");
    for (const gone of ["Graded", "Against it", "refuted", "muse/m", "alice", "next login sends the token again"]) {
      assert.ok(!text.includes(gone), gone);
    }
  });
});

describe("bySeverity", () => {
  it("sorts by grade and keeps the order within one", () => {
    const sorted = bySeverity([finding({ severity: "ASK", title: "q" }), finding({ severity: "P3", title: "c" }), finding({ title: "b" }), finding({ severity: "P1", title: "a" }), finding({ severity: "P3", title: "d" })]);
    assert.deepEqual(sorted.map((f) => f.title), ["a", "b", "c", "d", "q"]);
  });
});

describe("buildVerifyPrompt", () => {
  const input = { title: "T", description: "D", diff: "diff --git a b", language: "Korean", candidates: [finding(), finding({ severity: "P1", title: "Second", firing: { path: "src/a.ts", quote: "send(token);" } })], nonce: "n0nce" };

  it("numbers the findings, fences them and the PR text with the nonce, and says both are data", () => {
    const prompt = buildVerifyPrompt(input);
    assert.ok(prompt.includes("[1] P2 src/a.ts:3  Failure sent as no token") && prompt.includes("[2] P1 src/a.ts:3  Second"));
    for (const marker of ["BEGIN PULL REQUEST n0nce", "END PULL REQUEST n0nce", "BEGIN FINDINGS n0nce", "END FINDINGS n0nce"]) {
      assert.ok(prompt.includes(`=== ${marker} ===`), marker);
    }
    assert.ok(prompt.indexOf("[1] P2") > prompt.indexOf("BEGIN FINDINGS") && prompt.indexOf("[1] P2") < prompt.indexOf("END FINDINGS"));
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /in Korean/);
    assert.match(prompt, /Condition: lookup rejects/);
    assert.match(prompt, /Firing:\n- src\/a\.ts send\(token\);/);
  });

  it("asks to refute and not to find new problems, with a quote, and does not let size or confidence decide", () => {
    const prompt = buildVerifyPrompt(input);
    for (const text of ["try to refute them", "Do not look for new problems", "deliberate, documented trade-off", "counts as \"unclear\"", "because it is small", "sounded sure"]) {
      assert.ok(prompt.includes(text), text);
    }
  });

  it("picks another marker when the PR's text or a finding contains the nonce", () => {
    assert.ok(!buildVerifyPrompt({ ...input, description: "n0nce" }).includes("BEGIN PULL REQUEST n0nce"));
    assert.ok(!buildVerifyPrompt({ ...input, candidates: [finding({ detail: "n0nce" })] }).includes("BEGIN FINDINGS n0nce"));
  });
});
