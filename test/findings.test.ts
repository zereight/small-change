import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatComment, headline } from "../src/review/comment.ts";
import { parseDiff } from "../src/review/diff.ts";
import { type Finding, FindingsError, parseFindings } from "../src/review/findings.ts";
import { buildQuoteChecker } from "../src/review/material.ts";
import { buildPrompt } from "../src/review/prompt.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const items = load();
-const total = items.length;
+const total = items.length - 1;
+return total;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-export const unrelated = true;
+export const other = readConfiguration();
`;
const check = buildQuoteChecker(parseDiff(DIFF), []);

const QUOTE = { path: "src/a.ts", line: 2, quote: "const total = items.length - 1;" };

/** A P1 with everything it needs: a condition and a quote that is in the diff. */
const proven = (extra: Record<string, unknown> = {}) => ({
  severity: "P1",
  basis: "code",
  title: "Off by one",
  detail: "d",
  path: "src/a.ts",
  line: 2,
  condition: "items has exactly one element",
  evidence: [QUOTE],
  ...extra,
});

const parse = (entries: unknown[], max = 10) => parseFindings(JSON.stringify({ findings: entries }), max, check);

describe("parseFindings: reading the answer", () => {
  it("reads a findings object, a bare array, a fenced block and JSON after prose", () => {
    const list = JSON.stringify([proven()]);
    assert.equal(parseFindings(list, 10, check).findings.length, 1);
    assert.equal(parseFindings(`\`\`\`json\n${JSON.stringify({ findings: [proven()] })}\n\`\`\``, 10, check).findings.length, 1);
    assert.equal(parseFindings(`Here you go: ${JSON.stringify({ findings: [proven()] })} Thanks`, 10, check).findings.length, 1);
  });

  it("accepts an empty list", () => {
    assert.deepEqual(parse([]), { findings: [], dropped: 0, omitted: 0 });
  });

  it("throws when the answer is not JSON or has no list", () => {
    assert.throws(() => parseFindings("looks fine to me", 10, check), FindingsError);
    assert.throws(() => parseFindings('{"result":"ok"}', 10, check), /no "findings" list/);
    assert.throws(() => parseFindings("", 10, check), /\(empty\)/);
  });

  it("drops entries that are not findings and counts them", () => {
    const parsed = parse([proven(), proven({ severity: "P9", title: "bad level" }), proven({ title: "" }), "text", null, { severity: "P1" }]);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.dropped, 5);
  });

  it("normalizes the severity's case", () => {
    assert.equal(parse([proven({ severity: " p1 " })]).findings[0]?.severity, "P1");
  });

  it("sorts by severity with questions last, keeps the model's order within one, and applies the limit", () => {
    const parsed = parse(
      [
        proven({ severity: "ASK", title: "q" }),
        proven({ severity: "P3", title: "c" }),
        proven({ title: "a" }),
        proven({ severity: "P2", title: "b" }),
        proven({ title: "a2", line: 3 }),
      ],
      4,
    );
    assert.deepEqual(parsed.findings.map((f) => f.title), ["a", "a2", "b", "c"]);
    assert.equal(parsed.omitted, 1);
  });

  it("drops duplicates", () => {
    assert.equal(parse([proven(), proven()]).findings.length, 1);
  });

  it("ignores bad paths and lines but keeps the finding", () => {
    const parsed = parse([proven({ severity: "P3", path: "a\nb", line: -3 }), proven({ severity: "P3", title: "y", path: 5, line: 1.5 })]);
    assert.deepEqual(parsed.findings.map((f) => [f.path, f.line]), [[undefined, undefined], [undefined, undefined]]);
  });

  it("clips a long title and collapses its whitespace", () => {
    const title = parse([proven({ severity: "P3", title: `a\n\n  b ${"x".repeat(500)}` })]).findings[0]?.title ?? "";
    assert.ok(title.length <= 120 && !title.includes("\n") && title.startsWith("a b x"));
  });
});

describe("parseFindings: grading", () => {
  const only = (entry: Record<string, unknown>): Finding => {
    const [finding] = parse([entry]).findings;
    assert.ok(finding);
    return finding;
  };

  it("keeps a proven P1 as it is, with its quotes", () => {
    const finding = only(proven());
    assert.equal(finding.severity, "P1");
    assert.equal(finding.lowered, undefined);
    assert.deepEqual(finding.evidence, [QUOTE]);
    assert.equal(finding.condition, "items has exactly one element");
  });

  it("lowers a P1 or P2 with no condition to P3", () => {
    const { condition: _omit, ...noCondition } = proven();
    for (const severity of ["P1", "P2"]) {
      const finding = only({ ...noCondition, severity });
      assert.equal(finding.severity, "P3");
      assert.deepEqual(finding.lowered, { from: severity, reason: "no trigger condition was given" });
    }
  });

  it("lowers a P1 with no evidence to P3", () => {
    const finding = only(proven({ evidence: [] }));
    assert.equal(finding.severity, "P3");
    assert.equal(finding.lowered?.reason, "no evidence quote was given");
  });

  it("lowers a P2 whose quote is not in what was shown, and drops that quote", () => {
    const finding = only(proven({ severity: "P2", evidence: [{ path: "src/a.ts", quote: "const invented = somethingElse();" }] }));
    assert.equal(finding.severity, "P3");
    assert.equal(finding.lowered?.reason, "no evidence quote was found in the code shown");
    assert.deepEqual(finding.evidence, []);
  });

  it("keeps the quotes that are real and drops the ones that are not", () => {
    const finding = only(proven({ evidence: [QUOTE, { path: "src/a.ts", quote: "const invented = somethingElse();" }] }));
    assert.equal(finding.severity, "P1");
    assert.deepEqual(finding.evidence, [QUOTE]);
  });

  it("accepts a quote that keeps the diff's markers, or has other whitespace", () => {
    assert.equal(only(proven({ evidence: [{ path: "src/a.ts", quote: "+const total = items.length - 1;\n+return total;" }] })).severity, "P1");
    assert.equal(only(proven({ evidence: [{ path: "src/a.ts", quote: "const   total =\n  items.length - 1;" }] })).severity, "P1");
  });

  it("takes a path with a/ or b/ in front, and a bare string as a quote in the finding's file", () => {
    assert.equal(only(proven({ evidence: [{ path: "b/src/a.ts", quote: QUOTE.quote }] })).severity, "P1");
    assert.equal(only(proven({ evidence: ["const total = items.length - 1;"] })).severity, "P1");
  });

  it("does not count a quote that is in another file, or one too short to prove anything", () => {
    assert.equal(only(proven({ evidence: [{ path: "src/b.ts", quote: QUOTE.quote }] })).severity, "P3");
    assert.equal(only(proven({ evidence: [{ path: "src/a.ts", quote: "items.len" }] })).severity, "P3");
    assert.equal(only(proven({ evidence: [{ path: "src/a.ts", quote: "total;" }] })).severity, "P3");
    assert.equal(only(proven({ evidence: [{ path: "src/a.ts", quote: "return total;" }] })).severity, "P1");
  });

  it("makes a P1 that rests on a contract a question, even with real quotes", () => {
    const finding = only(proven({ basis: "contract" }));
    assert.equal(finding.severity, "ASK");
    assert.match(finding.lowered?.reason ?? "", /contract or on code that was not shown/);
  });

  it("asks for a firing quote when the defect needs a run-time event", () => {
    const none = only(proven({ basis: "event" }));
    assert.equal(none.severity, "P3");
    assert.match(none.lowered?.reason ?? "", /no quote shows the event happening/);

    const fake = only(proven({ basis: "event", firing: { path: "src/b.ts", quote: "somethingThatThrows(argument)" } }));
    assert.equal(fake.severity, "P3");
    assert.match(fake.lowered?.reason ?? "", /was not found in the code shown/);

    const real = only(proven({ basis: "event", firing: { path: "src/b.ts", quote: "export const other = readConfiguration();" } }));
    assert.equal(real.severity, "P1");
    assert.equal(real.firing?.path, "src/b.ts");
  });

  it("treats a missing or unknown basis as code", () => {
    const { basis: _omit, ...noBasis } = proven();
    assert.equal(only(noBasis).basis, "code");
    assert.equal(only(proven({ basis: "folklore" })).basis, "code");
  });

  it("does not lower P3 or ASK, but still drops quotes that are not real", () => {
    for (const severity of ["P3", "ASK"] as const) {
      const finding = only({ severity, title: "t", detail: "", evidence: [{ path: "src/a.ts", quote: "made up code that is not there" }] });
      assert.equal(finding.severity, severity);
      assert.equal(finding.lowered, undefined);
      assert.deepEqual(finding.evidence, []);
    }
  });

  it("checks quotes against the code of expanded files too", () => {
    const context = [{ path: "src/c.ts", shown: "export function helper() {\n  return compute(value);\n}" }] as never;
    const withContext = buildQuoteChecker(parseDiff(DIFF), context);
    assert.equal(withContext("src/c.ts", "return compute(value);"), true);
    assert.equal(check("src/c.ts", "return compute(value);"), false);
  });
});

describe("comment", () => {
  const base: Finding = { severity: "P2", title: "Null deref", detail: "Fix it", basis: "code", path: "src/a.ts", line: 9, evidence: [] };
  const EN = ["English"];
  const BOTH = ["English", "Korean"];
  const full: Finding = {
    ...base,
    condition: "items has one element",
    evidence: [{ path: "src/a.ts", line: 2, quote: "const total = items.length - 1;" }],
    translations: [{ language: "Korean", title: "널 역참조", condition: "items에 원소가 하나뿐일 때" }],
  };

  it("starts with the grade so small-change's default pattern counts P1 and P2 but not a question", () => {
    const text = formatComment(base, EN);
    assert.equal(text.split("\n")[0], "**P2** Null deref");
    assert.match(text.split("\n")[0] as string, /\bP[12]\b/);
    assert.ok(text.includes("`src/a.ts:9`"));
    assert.doesNotMatch(formatComment({ ...base, severity: "ASK" }, EN).split("\n")[0] as string, /\bP[12]\b/);
  });

  it("is only the grade, the title, the place, the condition and the evidence, in English and Korean", () => {
    assert.equal(
      formatComment(full, BOTH),
      [
        "**P2** Null deref\n널 역참조",
        "`src/a.ts:9`",
        "Condition: items has one element\n조건: items에 원소가 하나뿐일 때",
        "Evidence / 증거:\n- `src/a.ts:2` `const total = items.length - 1;`",
      ].join("\n\n"),
    );
  });

  it("leaves out everything else: the detail, the firing, the grading history, the counter quote and a footer", () => {
    const text = formatComment(
      {
        ...full,
        detail: "THE DETAIL",
        firing: { quote: "throw new Error(`boom`)" },
        lowered: { from: "P1", reason: "no trigger condition was given" },
        counter: { path: "b.ts", line: 2, quote: "COUNTER" },
        opinion: { verdict: "refuted", reason: "OPINION" },
      },
      BOTH,
    );
    for (const gone of ["THE DETAIL", "Firing", "Graded", "no trigger condition", "Against it", "COUNTER", "OPINION", "small-change review", "commit", "looked up", "checked by"]) {
      assert.ok(!text.includes(gone), gone);
    }
  });

  it("leaves out a part the finding does not have, and keeps a translation that is missing out of it", () => {
    assert.equal(formatComment(base, BOTH), "**P2** Null deref\n\n`src/a.ts:9`");
    assert.equal(formatComment({ ...base, condition: "c" }, BOTH), "**P2** Null deref\n\n`src/a.ts:9`\n\nCondition: c");
    const onlyTranslated = formatComment({ ...base, translations: [{ language: "Korean", title: "제목" }] }, BOTH);
    assert.equal(onlyTranslated, "**P2** Null deref\n제목\n\n`src/a.ts:9`");
  });

  it("puts the labels in each language, and English ones for a language it has none for", () => {
    const ja = formatComment(
      { ...base, condition: "c", evidence: [{ quote: "x" }], translations: [{ language: "Japanese", title: "ヌル", condition: "条件" }] },
      ["English", "Japanese"],
    );
    assert.match(ja, /Condition: c\nCondition: 条件/);
    assert.match(ja, /\n\nEvidence:\n- `x`$/);
    const korean = formatComment({ ...base, condition: "c", evidence: [{ quote: "x" }] }, ["korean"]);
    assert.match(korean, /조건: c/);
    assert.match(korean, /증거:/);
  });

  it("uses only the translations in the languages asked for, in that order", () => {
    const text = formatComment(
      { ...base, translations: [{ language: "Japanese", title: "J" }, { language: "Korean", title: "K" }] },
      ["English", "Korean"],
    );
    assert.equal(text.split("\n").slice(0, 2).join("|"), "**P2** Null deref|K");
    assert.ok(!text.includes("J"));
  });

  describe("the default finding pattern, which the check applies to the whole comment", () => {
    const pattern = /\bP[12]\b/i;

    it("does not count a P3 or a question, whatever their text names", () => {
      for (const severity of ["P3", "ASK"] as const) {
        const text = formatComment(
          {
            ...base,
            severity,
            title: "Not a P1",
            condition: "if P1 happens",
            evidence: [{ path: "a.ts", line: 1, quote: "const P1 = 2;" }],
            translations: [{ language: "Korean", title: "P2가 아님", condition: "P1이 일어나면" }],
          },
          BOTH,
        );
        assert.doesNotMatch(text, pattern, severity);
        assert.match(text.replace(/\u200B/g, ""), /Not a P1\nP2가 아님/, "reads the same without the invisible character");
      }
    });

    it("counts a P1 or P2 by its headline, and leaves the words of its text alone", () => {
      for (const severity of ["P1", "P2"] as const) {
        const text = formatComment({ ...base, severity, condition: "like the P1 before" }, EN);
        assert.match(text.split("\n")[0] as string, pattern);
        assert.ok(text.includes("like the P1 before"));
      }
    });

    it("keeps the same headline for skipping a repeat when a P3's title names a grade", () => {
      const a = { ...base, severity: "P3" as const, title: "Was P1, now minor" };
      assert.equal(formatComment(a, EN).split("\n")[0], headline(a));
      assert.doesNotMatch(headline(a), pattern);
    });
  });

  it("neutralizes mentions and images in every field, and cannot leave a code span", () => {
    const text = formatComment(
      {
        ...base,
        title: "ping @alice",
        condition: "by @bob",
        evidence: [{ quote: "a `b` @carol ![i](u)" }],
        translations: [{ language: "Korean", title: "@dave ![y](https://evil.example/)", condition: "@erin" }],
      },
      BOTH,
    );
    assert.ok(!/@\w/.test(text) && !text.includes("@{"));
    assert.ok(!text.includes("![y]") && !text.includes("![i]"));
    assert.match(text, /`a 'b' @\u200Bcarol !\\\[i\]\(u\)`/);
  });

  it("gives the same headline to the same finding, for skipping a repeat", () => {
    const a = { ...base, title: "Same @bob", condition: "one" };
    const b = { ...base, title: "Same @bob", condition: "two" };
    assert.equal(headline(a), headline(b));
    assert.equal(formatComment(a, EN).split("\n")[0], headline(a));
  });
});

describe("parseFindings: translations", () => {
  const check = () => true;
  const answer = (translations: unknown) =>
    JSON.stringify({ findings: [{ severity: "P3", title: "Nit", detail: "", translations }] });

  it("keeps one translation per language asked for, in the order asked, and drops the rest", () => {
    const parsed = parseFindings(
      answer([
        { language: "Japanese", title: "J", condition: "jc" },
        { language: "korean", title: "  한국어  제목 ", condition: " 조건 " },
        { language: "Korean", title: "second Korean" },
        { language: "French", title: "F" },
        { language: "Japanese", title: "" },
        "Korean",
        null,
      ]),
      10,
      check,
      ["Korean", "Japanese"],
    );
    assert.deepEqual(parsed.findings[0]?.translations, [
      { language: "Korean", title: "한국어 제목", condition: "조건" },
      { language: "Japanese", title: "J", condition: "jc" },
    ]);
  });

  it("leaves the field out when there is none, when none is asked for, or when it is not a list", () => {
    assert.equal(parseFindings(answer([{ language: "Korean", title: "K" }]), 10, check).findings[0]?.translations, undefined);
    assert.equal(parseFindings(answer("Korean: K"), 10, check, ["Korean"]).findings[0]?.translations, undefined);
    assert.equal(parseFindings(answer(undefined), 10, check, ["Korean"]).findings[0]?.translations, undefined);
    assert.equal(parseFindings(answer([{ language: "Korean", title: "K" }]), 10, check, ["Korean"]).findings[0]?.translations?.[0]?.condition, undefined);
  });
});

describe("buildPrompt: languages", () => {
  const input = { title: "T", description: "D", diff: "diff --git a b", maxFindings: 7, nonce: "n0nce" };

  it("asks for a translation of the title and condition in each language after the first", () => {
    const prompt = buildPrompt({ ...input, languages: ["English", "Korean", "Japanese"] });
    assert.match(prompt, /in English\./);
    assert.match(prompt, /for each of Korean, Japanese/);
    assert.ok(prompt.includes('"translations":[{"language":"Korean","title":"...","condition":"..."}]'));
  });

  it("asks for no translations when there is one language", () => {
    const prompt = buildPrompt({ ...input, languages: ["Korean"] });
    assert.match(prompt, /in Korean\./);
    assert.doesNotMatch(prompt, /translations/);
  });
});

describe("buildPrompt", () => {
  const input = { title: "T", description: "D", diff: "diff --git a b", languages: ["Korean"], maxFindings: 7, nonce: "n0nce" };
  const file = { path: "src/c.ts", numbered: "1| a\n2| b", shown: "a\nb", ranges: "1-2", totalLines: 2, whole: true, truncated: false, bytes: 9 };

  it("fences the PR text and the code with the nonce and says it is data", () => {
    const prompt = buildPrompt({ ...input, files: [file] });
    assert.ok(prompt.includes("=== BEGIN PULL REQUEST n0nce ===") && prompt.includes("=== END PULL REQUEST n0nce ==="));
    assert.ok(prompt.indexOf("1| a") > prompt.indexOf("BEGIN PULL REQUEST") && prompt.indexOf("1| a") < prompt.indexOf("END PULL REQUEST"));
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /in Korean/);
    assert.match(prompt, /at most 7 findings/);
  });

  it("describes the code shown, and lists what was not shown with the reason", () => {
    const prompt = buildPrompt({
      ...input,
      files: [file, { ...file, path: "src/big.ts", whole: false, ranges: "10-50, 80-90", totalLines: 900, truncated: true }],
      omitted: [{ path: "package-lock.json", reason: "lock file" }],
    });
    assert.match(prompt, /### src\/c\.ts \(whole file, 2 lines\)/);
    assert.match(prompt, /### src\/big\.ts \(lines 10-50, 80-90 of 900, cut at the size limit\)/);
    assert.match(prompt, /Not shown:\n- package-lock\.json: lock file/);
  });

  it("says when only the diff is available", () => {
    assert.match(buildPrompt(input), /\(none: only the diff is available\)/);
  });

  it("asks for proof, a self-challenge and the answer shape, and no longer forbids looking past the diff", () => {
    const prompt = buildPrompt(input);
    for (const word of ["\"basis\"", "\"condition\"", "\"evidence\"", "\"firing\"", "ASK", "try to refute it", "word for word"]) {
      assert.ok(prompt.includes(word), word);
    }
    assert.ok(!prompt.includes("Report only problems that the diff shows"));
  });

  it("picks another marker when the PR's text or the code contains the nonce", () => {
    assert.ok(!buildPrompt({ ...input, description: "n0nce" }).includes("BEGIN PULL REQUEST n0nce"));
    assert.ok(!buildPrompt({ ...input, files: [{ ...file, numbered: "1| n0nce" }] }).includes("BEGIN PULL REQUEST n0nce"));
  });

  it("uses a random marker by default, different per call", () => {
    const { nonce: _ignored, ...rest } = input;
    const marker = (text: string) => /BEGIN PULL REQUEST (\w+)/.exec(text)?.[1];
    assert.notEqual(marker(buildPrompt(rest)), marker(buildPrompt(rest)));
  });
});
