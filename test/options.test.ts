import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs, UsageError } from "../src/options.ts";

const URL = "https://bitbucket.org/team/repo/pull-requests/7";

function run(...args: string[]) {
  const input = parseCliArgs(args);
  assert.equal(input.kind, "run");
  return input.kind === "run" ? input : (undefined as never);
}

describe("parseCliArgs", () => {
  it("applies the defaults of the policy", () => {
    const { ref, options } = run(URL, "--kind", "backend");
    assert.deepEqual(ref, { workspace: "team", repo: "repo", id: 7 });
    assert.equal(options.maxLines, 1000);
    assert.equal(options.maxServices, 3);
    assert.equal(options.minMergedPullRequests, 10);
    assert.equal(options.serviceDepth, 2);
    assert.equal(options.historyScanLimit, 100);
    assert.deepEqual(options.bots, []);
    assert.ok(options.findingPattern.test("P1"));
    assert.ok(options.findingPattern.test("p2"));
    assert.ok(!options.findingPattern.test("P3"));
  });

  it("maps --kind frontend to a limit of 2: one affected service is allowed", () => {
    assert.equal(run(URL, "--kind", "frontend").options.maxServices, 2);
  });

  it("takes --max-services instead of --kind", () => {
    assert.equal(run(URL, "--max-services", "5").options.maxServices, 5);
  });

  it("reads every override, and --bot more than once", () => {
    const { options } = run(
      URL, "--kind", "backend", "--max-lines", "500", "--min-merged", "3", "--service-depth", "1",
      "--history-limit", "20", "--bot", "a", "--bot", "b", "--finding-pattern", "critical|blocker",
    );
    assert.equal(options.maxLines, 500);
    assert.equal(options.minMergedPullRequests, 3);
    assert.equal(options.serviceDepth, 1);
    assert.equal(options.historyScanLimit, 20);
    assert.deepEqual(options.bots, ["a", "b"]);
    assert.ok(options.findingPattern.test("BLOCKER"));
  });

  it("returns help for -h and --help, even without a URL", () => {
    assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
    assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  });

  for (const [name, args, message] of [
    ["a missing URL", ["--kind", "backend"], /Missing required argument/],
    ["an extra argument", [URL, "extra", "--kind", "backend"], /Unexpected extra arguments: extra/],
    ["an invalid URL", ["https://github.com/o/r/pull/1", "--kind", "backend"], /Invalid PR URL/],
    ["a missing kind", [URL], /Missing --kind/],
    ["an unknown kind", [URL, "--kind", "mobile"], /Invalid --kind "mobile"/],
    ["kind with max-services", [URL, "--kind", "backend", "--max-services", "2"], /either --kind or --max-services/],
    ["a zero limit", [URL, "--kind", "backend", "--max-lines", "0"], /Invalid --max-lines "0"/],
    ["a non-integer", [URL, "--kind", "backend", "--min-merged", "1.5"], /Invalid --min-merged "1.5"/],
    ["an unknown option", [URL, "--kind", "backend", "--nope"], /nope/],
    ["a bad pattern", [URL, "--kind", "backend", "--finding-pattern", "("], /not a valid regular expression/],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseCliArgs([...args]), (error) => error instanceof UsageError && message.test(error.message));
    });
  }
});
