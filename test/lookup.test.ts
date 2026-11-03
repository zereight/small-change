import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanPath,
  clipLine,
  compose,
  describeNeed,
  failure,
  LIMITS,
  type LookupMode,
  LookupPool,
  lookupInstructions,
  matchesGlob,
  type Need,
  parseLookups,
} from "../src/review/lookup.ts";

const ALL = ["grep", "file", "callers", "skeleton"] as const;
const parse = (entries: unknown, allowed: readonly (typeof ALL)[number][] = ALL, max = 8) =>
  parseLookups(JSON.stringify({ lookups: entries }), allowed, max);

describe("parseLookups: reading a request", () => {
  it("is undefined when the answer is not a lookup request", () => {
    assert.equal(parseLookups('{"findings":[]}', ALL, 8), undefined);
    assert.equal(parseLookups("looks fine", ALL, 8), undefined);
    assert.equal(parseLookups('[{"grep":"abc"}]', ALL, 8), undefined);
    assert.equal(parseLookups('{"lookups":"grep"}', ALL, 8), undefined);
  });

  it("reads each kind, with defaults", () => {
    const parsed = parse([
      { grep: "AppConfig", glob: "*.kt" },
      { grep: "a.b\\(", regex: true, ignoreCase: true },
      { file: "src/a.ts", from: 10, to: 30 },
      { file: "src/b.ts" },
      { callers: "syncTokenAsync" },
      { skeleton: "src/c.ts" },
    ]);
    assert.deepEqual(parsed?.needs, [
      { kind: "grep", pattern: "AppConfig", regex: false, ignoreCase: false, glob: "*.kt" },
      { kind: "grep", pattern: "a.b\\(", regex: true, ignoreCase: true },
      { kind: "file", path: "src/a.ts", from: 10, to: 30 },
      { kind: "file", path: "src/b.ts", from: 1, to: 120 },
      { kind: "callers", symbol: "syncTokenAsync" },
      { kind: "skeleton", path: "src/c.ts" },
    ]);
    assert.equal(parsed?.dropped, 0);
  });

  it("works with findings in the same answer, and with a fenced block", () => {
    const text = JSON.stringify({ findings: [{ severity: "P1" }], lookups: [{ grep: "abc" }] });
    assert.equal(parseLookups(text, ALL, 8)?.needs.length, 1);
    assert.equal(parseLookups(`\`\`\`json\n${text}\n\`\`\``, ALL, 8)?.needs.length, 1);
  });

  it("treats an empty list as a request for nothing", () => {
    assert.deepEqual(parse([]), { needs: [], dropped: 0, excess: 0 });
  });

  it("drops kinds the engine cannot answer, and entries that are not requests, and counts them", () => {
    const parsed = parse([{ callers: "foo" }, { skeleton: "a.ts" }, "grep", null, 5, { nothing: 1 }, { grep: "abc" }], ["grep", "file"]);
    assert.deepEqual(parsed?.needs, [{ kind: "grep", pattern: "abc", regex: false, ignoreCase: false }]);
    assert.equal(parsed?.dropped, 6);
  });

  it("keeps the first of two identical requests, and applies the limit", () => {
    const parsed = parse([{ grep: "one" }, { grep: "one" }, { grep: "two" }, { grep: "three" }], ALL, 2);
    assert.deepEqual(parsed?.needs.map((need) => need.kind === "grep" && need.pattern), ["one", "two"]);
    assert.equal(parsed?.excess, 1);
  });
});

describe("parseLookups: what a request may contain", () => {
  const dropped = (entry: unknown) => parse([entry])?.dropped === 1;

  it("refuses a pattern that is short, long, or has a line break or NUL", () => {
    assert.ok(dropped({ grep: "ab" }));
    assert.ok(dropped({ grep: "   a " }));
    assert.ok(dropped({ grep: "x".repeat(LIMITS.maxPattern + 1) }));
    assert.ok(dropped({ grep: "a\nb c" }));
    assert.ok(dropped({ grep: "a\0b c" }));
    assert.ok(!dropped({ grep: "x".repeat(LIMITS.maxPattern) }));
    assert.ok(!dropped({ grep: "-rf --option" }), "a pattern that looks like an option is only a pattern");
  });

  it("refuses a glob that could name anything but files of the repository", () => {
    for (const glob of ["../*.kt", "/etc/*", ":(top)x", "-x", "a b", "*.{kt,java}", "x".repeat(LIMITS.maxGlob + 1)]) {
      assert.ok(dropped({ grep: "abc", glob }), glob);
    }
    for (const glob of ["*.kt", "src/**/*.ts", "core-native/", "Podfile"]) {
      assert.ok(!dropped({ grep: "abc", glob }), glob);
    }
    assert.ok(!dropped({ grep: "abc", glob: "" }));
    assert.ok(!dropped({ grep: "abc", glob: null }));
  });

  it("refuses a path that leaves the repository", () => {
    for (const file of ["../secret", "a/../../b", "/etc/passwd", "a//b", "dir/", "a\\b", "a\nb", "", " ", "x".repeat(LIMITS.maxPath + 1), "./"]) {
      assert.ok(dropped({ file }), JSON.stringify(file));
    }
    assert.deepEqual(parse([{ file: "./src/a.ts" }])?.needs[0], { kind: "file", path: "src/a.ts", from: 1, to: 120 });
  });

  it("limits a range of lines to what fits, and refuses one that ends before it starts", () => {
    assert.deepEqual(parse([{ file: "a.ts", from: 5, to: 5000 }])?.needs[0], { kind: "file", path: "a.ts", from: 5, to: 5 + LIMITS.maxFileLines - 1 });
    assert.deepEqual(parse([{ file: "a.ts", from: 0, to: -4, nonsense: 1 }])?.needs[0], { kind: "file", path: "a.ts", from: 1, to: 120 });
    assert.ok(dropped({ file: "a.ts", from: 50, to: 10 }));
    assert.deepEqual(parse([{ file: "a.ts", from: 7 }])?.needs[0], { kind: "file", path: "a.ts", from: 7, to: 126 });
  });

  it("allows a symbol name but not other text", () => {
    for (const symbol of ["foo", "Foo.bar", "use$Thing", "ns::fn", "List<T>"]) {
      assert.ok(!dropped({ callers: symbol }), symbol);
    }
    for (const symbol of ["foo bar", "foo;rm", "--help", "", "1abc", "x".repeat(LIMITS.maxSymbol + 1), "a\nb"]) {
      assert.ok(dropped({ callers: symbol }), JSON.stringify(symbol));
    }
  });
});

describe("cleanPath", () => {
  it("accepts plain repository paths", () => {
    assert.equal(cleanPath("a/b/c.ts"), "a/b/c.ts");
    assert.equal(cleanPath(" @features/x/y.tsx "), "@features/x/y.tsx");
    assert.equal(cleanPath(".github/workflows/ci.yml"), ".github/workflows/ci.yml");
  });
});

describe("matchesGlob", () => {
  it("matches a name without a slash against the file name", () => {
    assert.ok(matchesGlob("*.kt", "core/android/A.kt"));
    assert.ok(!matchesGlob("*.kt", "core/android/A.kts"));
    assert.ok(matchesGlob("A?.kt", "x/AB.kt"));
  });

  it("matches a glob with a slash against the whole path, where * stays in one directory and ** crosses them", () => {
    assert.ok(matchesGlob("src/*.ts", "src/a.ts"));
    assert.ok(!matchesGlob("src/*.ts", "src/deep/a.ts"));
    assert.ok(matchesGlob("src/**/*.ts", "src/deep/er/a.ts"));
    assert.ok(matchesGlob("src/**/*.ts", "src/a.ts"));
    assert.ok(matchesGlob("**/a.ts", "a.ts"));
    assert.ok(matchesGlob("**/a.ts", "x/y/a.ts"));
  });

  it("takes a glob without wildcards as a directory or a file name", () => {
    assert.ok(matchesGlob("core-native/", "core-native/android/A.kt"));
    assert.ok(matchesGlob("core-native/android", "core-native/android/A.kt"));
    assert.ok(!matchesGlob("core-native/android", "core-native/androidx/A.kt"));
    assert.ok(matchesGlob("Podfile", "apps/x/ios/Podfile"));
  });

  it("does not treat regex characters in a glob as regex", () => {
    assert.ok(matchesGlob("a+b.ts", "a+b.ts"));
    assert.ok(!matchesGlob("a+b.ts", "aab.ts"));
    assert.ok(!matchesGlob("a.ts", "abts"));
  });
});

describe("compose", () => {
  const need: Need = { kind: "grep", pattern: "abc", regex: false, ignoreCase: false };
  const entries = Array.from({ length: 10 }, (_, i) => ({ text: `f.ts:${i + 1}| line ${i + 1}`, seen: { path: "f.ts", text: `line ${i + 1}` } }));

  it("shows all entries when they fit, with the code they show", () => {
    const result = compose(need, entries, { maxChars: 10_000 });
    assert.equal(result.found, 10);
    assert.equal(result.shown, 10);
    assert.equal(result.note, undefined);
    assert.equal(result.seen.length, 10);
    assert.equal(result.body.split("\n").length, 10);
  });

  it("cuts at the entry limit and at the size limit, says so, and keeps seen to what is shown", () => {
    const byCount = compose(need, entries, { maxChars: 10_000, maxEntries: 3 });
    assert.equal(byCount.shown, 3);
    assert.equal(byCount.found, 10);
    assert.match(byCount.note ?? "", /7 more not shown/);
    assert.deepEqual(byCount.seen.map((seen) => seen.text), ["line 1", "line 2", "line 3"]);

    const bySize = compose(need, entries, { maxChars: 40 });
    assert.ok(bySize.body.length <= 40);
    assert.equal(bySize.seen.length, bySize.shown);
  });

  it("keeps the caller's note next to the cut", () => {
    assert.match(compose(need, entries, { maxChars: 10_000, maxEntries: 9, note: "the file has 10 lines" }).note ?? "", /the file has 10 lines; 1 more not shown/);
  });

  it("describes an entry with no code, such as a heading", () => {
    assert.equal(compose(need, [{ text: "heading" }], { maxChars: 100 }).seen.length, 0);
  });
});

describe("describeNeed and clipLine", () => {
  it("says what was asked", () => {
    assert.equal(describeNeed({ kind: "grep", pattern: "a b", regex: false, ignoreCase: true, glob: "*.kt" }), 'grep "a b" (text, ignoring case, in *.kt)');
    assert.equal(describeNeed({ kind: "grep", pattern: "x+", regex: true, ignoreCase: false }), 'grep "x+" (regular expression)');
    assert.equal(describeNeed({ kind: "file", path: "a.ts", from: 1, to: 9 }), "file a.ts, lines 1-9");
    assert.equal(describeNeed({ kind: "callers", symbol: "foo" }), "callers of foo");
    assert.equal(describeNeed({ kind: "skeleton", path: "a.ts" }), "signatures in a.ts");
  });

  it("cuts a long line, turns tabs into spaces and drops trailing space", () => {
    assert.equal(clipLine("a\tb   "), "a  b");
    const long = clipLine("x".repeat(1000));
    assert.equal(long.length, LIMITS.maxLineChars);
    assert.ok(long.endsWith("…"));
  });
});

describe("LookupPool", () => {
  const need = (pattern: string): Need => ({ kind: "grep", pattern, regex: false, ignoreCase: false });

  it("keeps answers in order, knows what it holds, and renders them", () => {
    const pool = new LookupPool();
    pool.add(compose(need("one"), [{ text: "a.kt:1| one", seen: { path: "a.kt", text: "one" } }], { maxChars: 1000 }));
    pool.add(failure(need("two"), "no such file"));
    assert.ok(pool.has(need("one")) && pool.has(need("two")) && !pool.has(need("three")));
    assert.equal(pool.size, 2);
    assert.deepEqual(pool.seen(), [{ path: "a.kt", text: "one" }]);
    const text = pool.render();
    assert.match(text, /### grep "one" \(text\): 1 found\na\.kt:1\| one/);
    assert.match(text, /### grep "two" \(text\): could not be run\n\(no such file\)/);
  });

  it("renders how many were cut", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ text: `l${i}` }));
    const pool = new LookupPool();
    pool.add(compose(need("many"), entries, { maxChars: 1000, maxEntries: 2 }));
    assert.match(pool.render(), /5 found, 2 shown/);
  });

  it("tracks how much room is left", () => {
    const pool = new LookupPool(100);
    assert.equal(pool.remaining(), 100);
    pool.add(compose(need("xx"), [{ text: "x".repeat(60) }], { maxChars: 1000 }));
    assert.ok(pool.remaining() < 40 && pool.remaining() > 0);
    pool.add(compose(need("yy"), [{ text: "y".repeat(60) }], { maxChars: 1000 }));
    assert.equal(pool.remaining(), 0);
  });

  it("holds one answer per request", () => {
    const pool = new LookupPool();
    pool.add(failure(need("same"), "first"));
    pool.add(failure(need("same"), "second"));
    assert.equal(pool.size, 1);
  });
});

describe("lookupInstructions", () => {
  const mode: LookupMode = { kinds: ["grep", "file"], max: 5, final: false };

  it("lists only the kinds the engine answers, the limit, and what happens to findings", () => {
    const text = lookupInstructions(mode, "findings");
    assert.match(text, /at most 5 lookups/);
    assert.match(text, /"grep"/);
    assert.match(text, /"file"/);
    assert.doesNotMatch(text, /"callers"|"skeleton"/);
    assert.match(text, /Findings in an answer that has lookups are ignored/);
    assert.match(lookupInstructions({ ...mode, kinds: ["grep", "file", "callers", "skeleton"] }, "findings"), /"callers".*\n.*"skeleton"/);
  });

  it("names verdicts for the verifier", () => {
    assert.match(lookupInstructions(mode, "verdicts"), /instead of verdicts/);
    assert.match(lookupInstructions(mode, "verdicts"), /Verdicts in an answer that has lookups are ignored/);
  });

  it("tells the agent on its last turn that it may not ask again", () => {
    const text = lookupInstructions({ ...mode, final: true }, "findings");
    assert.match(text, /last turn: answer with findings now/);
    assert.doesNotMatch(text, /at most 5 lookups/);
  });
});
