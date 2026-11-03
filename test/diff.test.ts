import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiff } from "../src/review/diff.ts";

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
