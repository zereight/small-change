import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiff, splitDiff } from "../src/review/diff.ts";

describe("parseDiff", () => {
  it("reads files, hunks with their new-side range, and the text without markers", () => {
    const [file] = parseDiff(`diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ function f() {
 keep
-old
+new one
+new two
@@ -50 +51,2 @@
-x
+y
+z
`);
    assert.equal(file?.path, "src/a.ts");
    assert.deepEqual(file?.hunks, [{ newStart: 10, newLines: 4 }, { newStart: 51, newLines: 2 }]);
    assert.equal(file?.text, "keep\nold\nnew one\nnew two\nx\ny\nz");
    assert.equal(file?.added, false);
    assert.equal(file?.deleted, false);
  });

  it("marks added, deleted and binary files", () => {
    const files = parseDiff(`diff --git a/n.ts b/n.ts
new file mode 100644
--- /dev/null
+++ b/n.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`);
    assert.deepEqual(files.map((f) => [f.path, f.added, f.deleted, f.binary]), [
      ["n.ts", true, false, false],
      ["gone.ts", false, true, false],
      ["logo.png", false, false, true],
    ]);
  });

  it("uses the new path of a rename and keeps a path with spaces from the +++ line", () => {
    const files = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
diff --git a/my file.ts b/my file.ts
--- a/my file.ts
+++ b/my file.ts
@@ -1 +1 @@
-a
+b
`);
    assert.deepEqual(files.map((f) => f.path), ["new.ts", "my file.ts"]);
  });

  it("does not take a removed line that starts with dashes for a file header", () => {
    const [file] = parseDiff(`diff --git a/x.sql b/x.sql
--- a/x.sql
+++ b/x.sql
@@ -1,2 +1,1 @@
--- a comment
+select 1;
`);
    assert.equal(file?.path, "x.sql");
    assert.equal(file?.text, "-- a comment\nselect 1;");
  });

  it("skips the no-newline marker, and gives no files for text that is not a diff", () => {
    const [file] = parseDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    assert.equal(file?.text, "a\nb");
    assert.deepEqual(parseDiff("File excluded by pattern"), []);
    assert.deepEqual(parseDiff(""), []);
  });

  it("gives a file with no hunks, such as one excluded by Bitbucket", () => {
    const [file] = parseDiff("diff --git a/package-lock.json b/package-lock.json\nFile excluded by pattern\n");
    assert.equal(file?.path, "package-lock.json");
    assert.deepEqual(file?.hunks, []);
  });
});

describe("splitDiff", () => {
  /** A file's diff of exactly `size` bytes. */
  const file = (name: string, size: number) => {
    const head = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n`;
    return head + "+".repeat(Math.max(0, size - head.length - 1)) + "\n";
  };

  it("keeps a diff that fits as one part, as it was, with whatever came before the first file", () => {
    const diff = `From abc\n${file("a.ts", 100)}${file("b.ts", 100)}`;
    assert.deepEqual(splitDiff(diff, 1000, 6), { parts: [diff], leftOut: [] });
    assert.deepEqual(splitDiff("not a diff", 1000, 6), { parts: ["not a diff"], leftOut: [] });
  });

  it("cuts between files, in the order of the diff, so every byte is in a part and no file is split", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((name) => file(name, 400));
    const { parts, leftOut } = splitDiff(files.join(""), 1000, 6);
    assert.deepEqual(leftOut, []);
    assert.deepEqual(parts, [files[0]! + files[1]!, files[2]! + files[3]!, files[4]!]);
    assert.equal(parts.join(""), files.join(""));
    assert.ok(parts.every((part) => Buffer.byteLength(part) <= 1000));
  });

  it("counts bytes, not characters", () => {
    const wide = (name: string) => `diff --git a/${name} b/${name}\n@@ -1 +1 @@\n+${"한".repeat(100)}\n`;
    const [a, b] = [wide("a.ts"), wide("b.ts")];
    assert.ok(Buffer.byteLength(a) > 300 && a.length < 200);
    assert.equal(splitDiff(a + b, Buffer.byteLength(a) + 10, 6).parts.length, 2);
  });

  it("lists a file whose diff alone is over the limit, and reviews the others", () => {
    const { parts, leftOut } = splitDiff(file("a.ts", 300) + file("big/gen.ts", 5000) + file("b.ts", 300), 1000, 6);
    assert.deepEqual(parts, [file("a.ts", 300) + file("b.ts", 300)]);
    assert.equal(leftOut.length, 1);
    assert.equal(leftOut[0]?.path, "big/gen.ts");
    assert.equal(leftOut[0]?.bytes, 5000);
    assert.match(leftOut[0]?.reason ?? "", /alone is over the limit of 1000 bytes/);
  });

  it("stops at the last part allowed and lists every file after it, in order", () => {
    const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const { parts, leftOut } = splitDiff(names.map((name) => file(name, 600)).join(""), 1000, 2);
    assert.equal(parts.length, 2);
    assert.deepEqual(leftOut.map((entry) => entry.path), ["c.ts", "d.ts", "e.ts"]);
    assert.match(leftOut[0]?.reason ?? "", /past the last of 2 part\(s\)/);
  });

  it("fills the last part allowed with what fits, and lists the file that does not", () => {
    const fits = splitDiff(file("a.ts", 900) + file("b.ts", 900) + file("c.ts", 100), 1000, 2);
    assert.equal(fits.parts.length, 2);
    assert.deepEqual(fits.leftOut, [], "c.ts fits beside b.ts, in exactly 1000 bytes");
    const over = splitDiff(file("a.ts", 900) + file("b.ts", 900) + file("c.ts", 101), 1000, 2);
    assert.equal(over.parts.length, 2);
    assert.deepEqual(over.leftOut.map((entry) => entry.path), ["c.ts"]);
  });

  it("names a file that was left out by its new path, also for a rename", () => {
    const rename = "diff --git a/old/a.ts b/new/a.ts\nsimilarity index 90%\nrename from old/a.ts\nrename to new/a.ts\n";
    const { leftOut } = splitDiff(file("a.ts", 900) + rename, 950, 1);
    assert.deepEqual(leftOut.map((entry) => entry.path), ["new/a.ts"]);
    assert.equal(leftOut[0]?.bytes, Buffer.byteLength(rename));
  });

  it("lists a large diff that is not in the git format, since it cannot be cut", () => {
    const { parts, leftOut } = splitDiff("x".repeat(2000), 1000, 6);
    assert.deepEqual(parts, []);
    assert.equal(leftOut.length, 1);
    assert.match(leftOut[0]?.reason ?? "", /not in the git format/);
  });

  it("returns an empty diff as it is, and does not lose the file that is last", () => {
    assert.deepEqual(splitDiff("", 1000, 6), { parts: [""], leftOut: [] });
    const last = file("z.ts", 700);
    assert.equal(splitDiff(file("a.ts", 700) + last, 1000, 6).parts.at(-1), last);
  });
});
