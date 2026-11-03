import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePullRequestUrl } from "../src/pr-url.ts";

describe("parsePullRequestUrl", () => {
  it("parses workspace, repository and id", () => {
    assert.deepEqual(parsePullRequestUrl("https://bitbucket.org/atlassian/aui/pull-requests/5484"), {
      workspace: "atlassian",
      repo: "aui",
      id: 5484,
    });
  });

  it("accepts a trailing slash and slugs with dots, dashes and underscores", () => {
    assert.deepEqual(parsePullRequestUrl("https://bitbucket.org/my-team/my_repo.git/pull-requests/7/"), {
      workspace: "my-team",
      repo: "my_repo.git",
      id: 7,
    });
  });

  for (const url of [
    "https://bitbucket.org/atlassian/aui/pull-requests/5484/diff",
    "https://bitbucket.org/atlassian/aui/pull-requests/5484?w=1",
    "https://bitbucket.org/atlassian/aui/pull-requests/5484#comment-1",
    "https://bitbucket.org/atlassian/aui/pull-requests/0",
    "https://bitbucket.org/atlassian/aui/pull-requests/abc",
    "https://bitbucket.org/atlassian/aui/pull-requests/12345678901",
    "https://bitbucket.org/atlassian/aui/pull/5484",
    "https://bitbucket.org/aui/pull-requests/5484",
    "https://bitbucket.org/a/b/c/pull-requests/5484",
    "https://bitbucket.org/atlassian/../pull-requests/5484",
    "https://bitbucket.org/atlassian/./pull-requests/5484",
    "https://bitbucket.org@evil.example.com/atlassian/aui/pull-requests/5484",
    "https://api.bitbucket.org/atlassian/aui/pull-requests/5484",
    "https://bitbucket.example.com/projects/KEY/repos/slug/pull-requests/5484",
    "http://bitbucket.org/atlassian/aui/pull-requests/5484",
    "https://github.com/owner/repo/pull/1",
    "not-a-url",
  ]) {
    it(`rejects ${url}`, () => {
      assert.equal(parsePullRequestUrl(url), undefined);
    });
  }
});
