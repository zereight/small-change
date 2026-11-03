import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBitbucket, HttpError } from "../src/bitbucket.ts";

const REF = { workspace: "team", repo: "repo", id: 7 };
const REPO_API = "https://api.bitbucket.org/2.0/repositories/team/repo";

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;

/** A fetch that answers with the first handler that returns a response, else 500. */
function fakeFetch(...handlers: Handler[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    calls.push({ url: href, init });
    for (const handler of handlers) {
      const response = handler(href, init);
      if (response) {
        return response;
      }
    }
    return new Response(`unexpected ${href}`, { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("getPullRequest", () => {
  it("maps the PR, the author and the destination commit", async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url === `${REPO_API}/pullrequests/7`
        ? json({
            id: 7,
            title: "Fix",
            description: "Details",
            author: { uuid: "{u}", display_name: "Alice", nickname: "alice" },
            source: { commit: { hash: "33c9a36c25ed" } },
            destination: { commit: { hash: "c1534197bde1" } },
          })
        : undefined,
    );

    const pr = await createBitbucket({ fetch: fetchImpl }).getPullRequest(REF);

    assert.deepEqual(pr, {
      id: 7,
      title: "Fix",
      description: "Details",
      author: { uuid: "{u}", name: "Alice", nickname: "alice" },
      sourceCommit: "33c9a36c25ed",
      destinationCommit: "c1534197bde1",
    });
  });

  it("reports a PR without a destination commit", async () => {
    const { fetchImpl } = fakeFetch(() => json({ id: 7, title: "x", source: { commit: { hash: "a" } }, destination: { commit: null } }));
    await assert.rejects(createBitbucket({ fetch: fetchImpl }).getPullRequest(REF), /no source or destination commit/);
  });
});

describe("getPullRequest: the source repository", () => {
  const prWith = (repository: unknown) =>
    fakeFetch((url) =>
      url === `${REPO_API}/pullrequests/7`
        ? json({
            id: 7,
            title: "Fix",
            author: { uuid: "{u}", display_name: "Alice" },
            source: { commit: { hash: "33c9a36c25ed" }, repository },
            destination: { commit: { hash: "c1534197bde1" } },
          })
        : undefined,
    );

  it("names the repository the branch lives in, which is another one for a fork", async () => {
    const pr = await createBitbucket({ fetch: prWith({ full_name: "someone/team-fork" }).fetchImpl }).getPullRequest(REF);
    assert.deepEqual(pr.sourceRepository, { workspace: "someone", repo: "team-fork" });
  });

  it("leaves it out when it is missing or is not two plain slugs, since it goes into a URL", async () => {
    for (const repository of [undefined, null, {}, { full_name: "one" }, { full_name: "a/b/c" }, { full_name: "../x" }, { full_name: "a/.." }, { full_name: "a/b c" }, { full_name: 5 }]) {
      const pr = await createBitbucket({ fetch: prWith(repository).fetchImpl }).getPullRequest(REF);
      assert.equal("sourceRepository" in pr, false, JSON.stringify(repository));
    }
  });
});

describe("getCommitHash", () => {
  const FULL = "33c9a36c25ed".padEnd(40, "0");

  it("gives the full hash for a short one", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => (url === `${REPO_API}/commit/33c9a36c25ed` ? json({ hash: FULL }) : undefined));
    assert.equal(await createBitbucket({ fetch: fetchImpl }).getCommitHash({ workspace: "team", repo: "repo" }, "33c9a36c25ed"), FULL);
    assert.equal(calls.length, 1);
  });

  it("is undefined for a commit the repository does not have, and for an answer that is not a full hash", async () => {
    const missing = fakeFetch(() => new Response("not found", { status: 404 }));
    assert.equal(await createBitbucket({ fetch: missing.fetchImpl }).getCommitHash({ workspace: "team", repo: "repo" }, "33c9a36c25ed"), undefined);
    for (const body of [{}, { hash: "33c9a36c25ed" }, { hash: 5 }]) {
      const odd = fakeFetch(() => json(body));
      assert.equal(await createBitbucket({ fetch: odd.fetchImpl }).getCommitHash({ workspace: "team", repo: "repo" }, "33c9a36c25ed"), undefined);
    }
  });

  it("refuses anything but hex before making a request, and passes other errors on", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("boom", { status: 500 }));
    const bitbucket = createBitbucket({ fetch: fetchImpl });
    for (const commit of ["", "abc", "../refs", "33c9a36c25ed/../x", "G".repeat(12), "33C9A36C25ED"]) {
      await assert.rejects(bitbucket.getCommitHash({ workspace: "team", repo: "repo" }, commit), /Not a commit hash/);
    }
    assert.equal(calls.length, 0);
    await assert.rejects(bitbucket.getCommitHash({ workspace: "team", repo: "repo" }, "33c9a36c25ed"), HttpError);
  });
});

describe("getFileChanges", () => {
  it("follows next links and maps added, removed and excluded files", async () => {
    const second = `${REPO_API}/pullrequests/7/diffstat?pagelen=100&page=2`;
    const { fetchImpl, calls } = fakeFetch(
      (url) =>
        url === `${REPO_API}/pullrequests/7/diffstat?pagelen=100`
          ? json({
              values: [{ lines_added: 3, lines_removed: 1, old: { path: "a.ts" }, new: { path: "b.ts" } }],
              next: second,
            })
          : undefined,
      (url) =>
        url === second
          ? json({
              values: [
                { lines_added: 5, lines_removed: 0, old: null, new: { path: "added.ts" } },
                { lines_added: null, lines_removed: null, old: { path: "yarn.lock" }, new: { path: "yarn.lock" } },
              ],
            })
          : undefined,
    );

    const changes = await createBitbucket({ fetch: fetchImpl }).getFileChanges(REF);

    assert.deepEqual(changes, [
      { oldPath: "a.ts", newPath: "b.ts", linesAdded: 3, linesRemoved: 1 },
      { newPath: "added.ts", linesAdded: 5, linesRemoved: 0 },
      { oldPath: "yarn.lock", newPath: "yarn.lock", linesAdded: 0, linesRemoved: 0 },
    ]);
    assert.equal(calls.length, 2);
  });

  it("refuses a next link on another host instead of sending the token there", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ values: [], next: "https://evil.example.com/steal?page=2" }),
    );

    await assert.rejects(
      createBitbucket({ token: "secret", fetch: fetchImpl }).getFileChanges(REF),
      /another host/,
    );
    assert.equal(calls.length, 1);
  });
});

describe("getComments", () => {
  it("drops deleted comments and marks resolved ones", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({
        values: [
          { id: 1, content: { raw: "P1 bug" }, user: { uuid: "{b}", display_name: "bot" } },
          { id: 2, deleted: true, content: { raw: "P1 gone" }, user: { uuid: "{b}", display_name: "bot" } },
          { id: 3, content: { raw: "P2 fixed" }, user: { uuid: "{b}", display_name: "bot" }, resolution: { type: "x" } },
        ],
      }),
    );

    const comments = await createBitbucket({ fetch: fetchImpl }).getComments(REF);

    assert.deepEqual(
      comments.map((comment) => [comment.id, comment.resolved]),
      [[1, false], [3, true]],
    );
  });
});

describe("listMergedPullRequestIds", () => {
  it("keeps merged PRs only, because the state filter is ignored next to a query", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        values: [
          { id: 5484, state: "MERGED" },
          { id: 5483, state: "DECLINED" },
          { id: 5470, state: "OPEN" },
          { id: 5376, state: "MERGED" },
        ],
      }),
    );

    const ids: number[] = [];
    for await (const id of createBitbucket({ fetch: fetchImpl }).listMergedPullRequestIds(REF, "{author-uuid}")) {
      ids.push(id);
    }

    assert.deepEqual(ids, [5484, 5376]);
    const query = new URL(calls[0]?.url ?? "").searchParams;
    assert.equal(query.get("q"), 'author.uuid="{author-uuid}"');
    assert.equal(query.get("sort"), "-updated_on");
  });

  it("reads pages lazily", async () => {
    const { fetchImpl, calls } = fakeFetch(
      (url) => (url.includes("page=2") ? json({ values: [{ id: 2, state: "MERGED" }] }) : undefined),
      () => json({ values: [{ id: 1, state: "MERGED" }], next: `${REPO_API}/pullrequests?page=2` }),
    );

    for await (const id of createBitbucket({ fetch: fetchImpl }).listMergedPullRequestIds(REF, "{u}")) {
      assert.equal(id, 1);
      break;
    }

    assert.equal(calls.length, 1);
  });
});

describe("getFile", () => {
  it("returns the file's text", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("libs/shared/\n"));
    const text = await createBitbucket({ fetch: fetchImpl }).getFile(REF, "c1534197bde1", ".small_change");
    assert.equal(text, "libs/shared/\n");
    assert.equal(calls[0]?.url, `${REPO_API}/src/c1534197bde1/.small_change`);
  });

  it("returns undefined for a file that does not exist", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 404 }));
    assert.equal(await createBitbucket({ fetch: fetchImpl }).getFile(REF, "abc", ".small_change"), undefined);
  });

  it("still fails on other errors", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 500 }));
    await assert.rejects(createBitbucket({ fetch: fetchImpl }).getFile(REF, "abc", ".small_change"), HttpError);
  });
});

describe("authentication and errors", () => {
  it("sends the token as a Bearer header on every request, and none without one", async () => {
    const withToken = fakeFetch(() => json({ values: [] }));
    await createBitbucket({ token: "bb-secret", fetch: withToken.fetchImpl }).getComments(REF);
    assert.equal(new Headers(withToken.calls[0]?.init?.headers).get("Authorization"), "Bearer bb-secret");

    const anonymous = fakeFetch(() => json({ values: [] }));
    await createBitbucket({ fetch: anonymous.fetchImpl }).getComments(REF);
    assert.equal(new Headers(anonymous.calls[0]?.init?.headers).get("Authorization"), null);
  });

  it("rejects a malformed token without echoing it", () => {
    assert.throws(
      () => createBitbucket({ token: "bb-ab\ncd" }),
      (error) => error instanceof Error && /can't be sent in an HTTP header/.test(error.message) && !error.message.includes("bb-ab"),
    );
  });

  it("explains a rate limit", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 429 }));
    await assert.rejects(createBitbucket({ fetch: fetchImpl }).getComments(REF), /429.*set BITBUCKET_TOKEN/);
  });

  it("hints at the token on 401, 403 and 404 without echoing it", async () => {
    for (const status of [401, 403, 404]) {
      const { fetchImpl } = fakeFetch(() => new Response("", { status }));
      const error = await createBitbucket({ token: "bb-secret", fetch: fetchImpl })
        .getPullRequest(REF)
        .catch((e: unknown) => e);
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.match(error.message, /check that BITBUCKET_TOKEN can read this repository/);
      assert.ok(!error.message.includes("bb-secret"));
    }
  });

  it("hints at setting a token for an anonymous caller", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 404 }));
    await assert.rejects(createBitbucket({ fetch: fetchImpl }).getPullRequest(REF), /for a private repository, set BITBUCKET_TOKEN/);
  });
});
