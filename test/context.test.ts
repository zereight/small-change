import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContext, skipReason } from "../src/review/context.ts";
import type { DiffFile } from "../src/review/diff.ts";

const file = (path: string, hunks: [number, number][] = [[1, 1]], extra: Partial<DiffFile> = {}): DiffFile => ({
  path,
  added: false,
  deleted: false,
  binary: false,
  hunks: hunks.map(([newStart, newLines]) => ({ newStart, newLines })),
  text: "",
  ...extra,
});

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
const reader = (files: Record<string, string | Error | undefined>) => async (path: string) => {
  const value = files[path];
  if (value instanceof Error) {
    throw value;
  }
  return value;
};

describe("skipReason", () => {
  it("skips what is not worth expanding, with the reason", () => {
    assert.equal(skipReason(file("a.ts", [[1, 1]], { deleted: true })), "deleted file");
    assert.equal(skipReason(file("a.ts", [[1, 1]], { binary: true })), "binary file");
    assert.equal(skipReason(file("logo.PNG")), "binary file");
    assert.equal(skipReason(file("a.ts", [])), "no textual changes in the diff");
    assert.match(skipReason(file("a.ts", [[1, 5]], { added: true })) ?? "", /^new file/);
    assert.equal(skipReason(file("package-lock.json")), "lock file");
    assert.equal(skipReason(file("apps/x/ios/Podfile.lock")), "lock file");
    assert.equal(skipReason(file("dist/app.min.js")), "generated or minified file");
    assert.equal(skipReason(file("src/__snapshots__/a.snap")), "generated or minified file");
    assert.equal(skipReason(file("src/api/types.pb.ts")), "generated or minified file");
    assert.equal(skipReason(file("src/a.ts")), undefined);
  });
});

describe("buildContext", () => {
  it("shows a small file whole, numbered, and checks quotes against what was shown", async () => {
    const context = await buildContext([file("src/a.ts")], reader({ "src/a.ts": "alpha\nbeta\ngamma\n" }), { lines: 40, totalBytes: 10_000 });
    assert.equal(context.files.length, 1);
    const [shown] = context.files;
    assert.equal(shown?.whole, true);
    assert.equal(shown?.numbered, "1| alpha\n2| beta\n3| gamma");
    assert.equal(shown?.shown, "alpha\nbeta\ngamma");
    assert.equal(shown?.totalLines, 3);
  });

  it("pads line numbers to one width", async () => {
    const context = await buildContext([file("a.ts")], reader({ "a.ts": lines(12) }), { lines: 40, totalBytes: 10_000 });
    assert.match(context.files[0]?.numbered ?? "", /^ 1\| line 1\n 2\| line 2/);
  });

  it("shows only the lines around the hunks of a large file, merging ranges that touch", async () => {
    const big = lines(2000);
    const context = await buildContext([file("big.ts", [[100, 3], [130, 2], [1500, 1]])], reader({ "big.ts": big }), {
      lines: 20,
      totalBytes: 100_000,
      wholeFileBytes: 100,
    });
    const [shown] = context.files;
    assert.equal(shown?.whole, false);
    assert.equal(shown?.ranges, "80-151, 1480-1520");
    assert.ok(shown?.numbered.includes("   ...\n"));
    assert.ok(shown?.numbered.includes(" 100| line 100"));
    assert.ok(!shown?.numbered.includes("line 500"));
    assert.ok(!shown?.shown.includes("line 500"));
  });

  it("keeps the regions inside the file at its start and end", async () => {
    const context = await buildContext([file("a.ts", [[2, 1], [99, 2]])], reader({ "a.ts": lines(100) }), { lines: 30, totalBytes: 100_000, wholeFileBytes: 10 });
    assert.equal(context.files[0]?.ranges, "1-32, 69-100");
  });

  it("leaves out files that are skipped, missing or unreadable, each with its reason", async () => {
    const context = await buildContext(
      [file("package-lock.json"), file("src/gone.ts"), file("src/err.ts"), file("src/ok.ts")],
      reader({ "src/err.ts": new Error("HTTP 403\nforbidden"), "src/ok.ts": "x = 1" }),
      { lines: 5, totalBytes: 10_000 },
    );
    assert.deepEqual(context.files.map((f) => f.path), ["src/ok.ts"]);
    assert.deepEqual(context.omitted, [
      { path: "package-lock.json", reason: "lock file" },
      { path: "src/gone.ts", reason: "not found at the source commit" },
      { path: "src/err.ts", reason: "could not be read: HTTP 403 forbidden" },
    ]);
  });

  it("stops at the total size and says which files did not fit, still fitting smaller ones after", async () => {
    const context = await buildContext(
      [file("a.ts"), file("b.ts"), file("c.ts")],
      reader({ "a.ts": "a".repeat(60), "b.ts": "b".repeat(600), "c.ts": "c".repeat(60) }),
      { lines: 5, totalBytes: 250, wholeFileBytes: 1000 },
    );
    assert.deepEqual(context.files.map((f) => f.path), ["a.ts", "c.ts"]);
    assert.deepEqual(context.omitted, [{ path: "b.ts", reason: "context size limit reached" }]);
    assert.ok(context.bytes <= 250);
  });

  it("cuts one file's regions at its share and marks it", async () => {
    const context = await buildContext(
      [file("a.ts", [[10, 1], [500, 1]])],
      reader({ "a.ts": lines(1000, "xxxxxxxxxxxxxxxxxxxx") }),
      { lines: 20, totalBytes: 100_000, wholeFileBytes: 10, perFileBytes: 1200 },
    );
    assert.equal(context.files[0]?.truncated, true);
    assert.equal(context.files[0]?.ranges, "1-30");
  });

  it("leaves out a file whose first region is over its share", async () => {
    const context = await buildContext([file("a.ts")], reader({ "a.ts": lines(100, "y".repeat(300)) }), { lines: 50, totalBytes: 100_000, wholeFileBytes: 10, perFileBytes: 500 });
    assert.deepEqual(context.files, []);
    assert.match(context.omitted[0]?.reason ?? "", /larger than the per-file limit/);
  });

  it("looks at no more files than the limit allows", async () => {
    const files = ["a", "b", "c"].map((name) => file(`${name}.ts`));
    const context = await buildContext(files, reader({ "a.ts": "1", "b.ts": "2", "c.ts": "3" }), { lines: 5, totalBytes: 10_000, maxFiles: 2 });
    assert.equal(context.files.length, 2);
    assert.deepEqual(context.omitted, [{ path: "c.ts", reason: "more than 2 changed files" }]);
  });

  it("reads nothing when the total is zero", async () => {
    const context = await buildContext([file("a.ts")], async () => assert.fail("must not read"), { lines: 5, totalBytes: 0 });
    assert.deepEqual(context, { files: [], omitted: [], bytes: 0 });
  });

  it("reads several files at once but never more than the limit, keeping the order", async () => {
    let running = 0;
    let peak = 0;
    const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`));
    const context = await buildContext(
      files,
      async (path) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return path;
      },
      { lines: 5, totalBytes: 100_000, concurrency: 3 },
    );
    assert.equal(peak, 3);
    assert.deepEqual(context.files.map((f) => f.path), files.map((f) => f.path));
  });

  it("shortens a very long line and still lets a quote of the visible part pass", async () => {
    const context = await buildContext([file("a.ts")], reader({ "a.ts": `short\n${"w".repeat(1000)}` }), { lines: 5, totalBytes: 100_000 });
    assert.ok((context.files[0]?.shown.length ?? 0) < 700);
    assert.ok(context.files[0]?.shown.includes("…"));
  });
});
