import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_EXCLUSIONS, parseExclusions } from "../src/patterns.ts";

const matches = (pattern: string, path: string) => parseExclusions(pattern).match(path) !== undefined;

describe("parseExclusions", () => {
  it("ignores blank lines and comments", () => {
    const matcher = parseExclusions("# shared code\n\n   \nlibs/shared/\n");
    assert.deepEqual(matcher.patterns, ["libs/shared/"]);
  });

  it("tolerates CRLF line endings and surrounding spaces", () => {
    assert.deepEqual(parseExclusions("  libs/shared/  \r\npayments\r\n").patterns, ["libs/shared/", "payments"]);
  });

  it("returns the first pattern that matches", () => {
    const matcher = parseExclusions("libs/\nlibs/shared/\n");
    assert.equal(matcher.match("libs/shared/a.ts"), "libs/");
  });

  it("matches nothing without patterns", () => {
    assert.equal(NO_EXCLUSIONS.match("anything"), undefined);
    assert.equal(parseExclusions("").match("anything"), undefined);
  });

  describe("a directory pattern", () => {
    it("covers everything under the directory, anchored at the root", () => {
      assert.ok(matches("libs/shared/", "libs/shared/index.ts"));
      assert.ok(matches("libs/shared/", "libs/shared/deep/er/file.ts"));
      assert.ok(!matches("libs/shared/", "apps/libs/shared/index.ts"));
      assert.ok(!matches("libs/shared/", "libs/shared-extra/index.ts"));
    });

    it("does not match a file of that name", () => {
      assert.ok(!matches("libs/shared/", "libs/shared"));
    });

    it("matches at any depth when it has no inner slash", () => {
      assert.ok(matches("secrets/", "secrets/key.txt"));
      assert.ok(matches("secrets/", "services/a/secrets/key.txt"));
    });
  });

  describe("a name pattern without a slash", () => {
    it("matches a file or directory of that name at any depth", () => {
      assert.ok(matches("payments", "payments/a.ts"));
      assert.ok(matches("payments", "services/payments/a.ts"));
      assert.ok(matches("payments", "services/payments"));
      assert.ok(!matches("payments", "services/payments-extra/a.ts"));
    });

    it("supports * within a segment", () => {
      assert.ok(matches("*.lock", "yarn.lock"));
      assert.ok(matches("*.lock", "apps/web/yarn.lock"));
      assert.ok(!matches("*.lock", "yarn.lock.md"));
    });

    it("supports ? for one character", () => {
      assert.ok(matches("v?.json", "v1.json"));
      assert.ok(!matches("v?.json", "v10.json"));
    });
  });

  describe("an anchored pattern", () => {
    it("matches from the repository root only", () => {
      assert.ok(matches("/Makefile", "Makefile"));
      assert.ok(!matches("/Makefile", "tools/Makefile"));
      assert.ok(matches("infra/terraform", "infra/terraform/main.tf"));
      assert.ok(!matches("infra/terraform", "other/infra/terraform/main.tf"));
    });

    it("keeps * within one segment", () => {
      assert.ok(matches("services/*/migrations/", "services/payments/migrations/1.sql"));
      assert.ok(!matches("services/*/migrations/", "services/a/b/migrations/1.sql"));
    });
  });

  describe("**", () => {
    it("crosses segments as a leading, inner or trailing component", () => {
      assert.ok(matches("**/migrations/", "a/b/migrations/1.sql"));
      assert.ok(matches("**/migrations/", "migrations/1.sql"));
      assert.ok(matches("services/**/migrations/", "services/a/b/migrations/1.sql"));
      assert.ok(matches("services/**/migrations/", "services/migrations/1.sql"));
      assert.ok(matches("docs/**", "docs/a/b.md"));
      assert.ok(!matches("docs/**", "other/docs/a.md"));
    });
  });

  it("escapes regular expression characters", () => {
    assert.ok(matches("a+b(1).ts", "a+b(1).ts"));
    assert.ok(!matches("a.b", "axb"));
  });

  it("refuses negation instead of guessing", () => {
    assert.throws(() => parseExclusions("libs/\n!libs/keep/"), /line 2: negation/);
  });

  it("refuses a pattern that names no path", () => {
    assert.throws(() => parseExclusions("/"), /line 1: the pattern names no path/);
  });
});
