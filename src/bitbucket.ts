import type { PullRequestRef } from "./pr-url.ts";

export type RepositoryRef = Pick<PullRequestRef, "workspace" | "repo">;

export interface Person {
  uuid: string;
  /** The display name, or the nickname when there is none. */
  name: string;
  nickname?: string;
}

export interface PullRequest {
  id: number;
  title: string;
  author: Person;
  /** The destination branch's tip. The exclusion file is read here, never from the PR's own head. */
  destinationCommit: string;
}

/** One file of a PR's diffstat. `oldPath` is absent for an added file, `newPath` for a removed one. */
export interface FileChange {
  oldPath?: string;
  newPath?: string;
  /** Zero for a file Bitbucket left out of the diff by its own exclusion patterns. */
  linesAdded: number;
  linesRemoved: number;
}

export interface ReviewComment {
  id: number;
  author: Person;
  body: string;
  /** Whether the comment's thread was marked resolved. */
  resolved: boolean;
}

/** The slice of Bitbucket Cloud that the checks need. */
export interface Bitbucket {
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  getFileChanges(ref: PullRequestRef): Promise<FileChange[]>;
  /** Every comment that was not deleted, replies included. */
  getComments(ref: PullRequestRef): Promise<ReviewComment[]>;
  /** The ids of the author's merged PRs in a repository, newest first; reads pages lazily. */
  listMergedPullRequestIds(repository: RepositoryRef, authorUuid: string): AsyncIterable<number>;
  /** The file's text at `commit`, or undefined when it does not exist there. */
  getFile(repository: RepositoryRef, commit: string, path: string): Promise<string | undefined>;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface BitbucketOptions {
  /** An access token, sent as a Bearer token to api.bitbucket.org only. */
  token?: string | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const API_ROOT = "https://api.bitbucket.org/2.0";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LENGTH = 100;
/** Guards against a pagination bug causing an unbounded loop, not an expected limit. */
const MAX_PAGES = 100;

interface RawPerson {
  uuid?: string;
  display_name?: string;
  nickname?: string;
}

interface Page<T> {
  values?: T[];
  next?: string;
}

export function createBitbucket(options: BitbucketOptions = {}): Bitbucket {
  const doFetch = options.fetch ?? fetch;
  const headers = authorizationHeaders(options.token);
  const hasToken = Boolean(options.token);

  async function getResponse(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Bitbucket request timed out after ${REQUEST_TIMEOUT_MS} ms: ${url}`);
      }
      throw error;
    }
    if (!response.ok) {
      throw httpError(response.status, url, hasToken);
    }
    return response;
  }

  async function getJson<T>(url: string): Promise<T> {
    return (await getResponse(url)).json() as Promise<T>;
  }

  /** Yields the items of a paginated list, following `next` links on the first URL's origin only. */
  async function* listItems<T>(firstUrl: string): AsyncGenerator<T> {
    const origin = new URL(firstUrl).origin;
    let url: string | undefined = firstUrl;
    for (let page = 0; url !== undefined; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(`Bitbucket list exceeded ${MAX_PAGES} pages: ${firstUrl}`);
      }
      const body: Page<T> = await getJson<Page<T>>(url);
      if (!Array.isArray(body.values)) {
        throw new Error(`Bitbucket returned an unexpected response for ${url}`);
      }
      yield* body.values;
      const next: string | undefined = body.next;
      if (next !== undefined && new URL(next).origin !== origin) {
        throw new Error(`Bitbucket pointed pagination of ${firstUrl} at another host: ${next}`);
      }
      url = next;
    }
  }

  async function collect<T>(firstUrl: string): Promise<T[]> {
    const items: T[] = [];
    for await (const item of listItems<T>(firstUrl)) {
      items.push(item);
    }
    return items;
  }

  // Workspace and repository slugs are validated segment by segment (pr-url.ts), so they go into
  // URLs as they are.
  const repositoryUrl = (repository: RepositoryRef) =>
    `${API_ROOT}/repositories/${repository.workspace}/${repository.repo}`;
  const pullRequestUrl = (ref: PullRequestRef) => `${repositoryUrl(ref)}/pullrequests/${ref.id}`;

  return {
    async getPullRequest(ref) {
      const raw = await getJson<{
        id: number;
        title?: string;
        author?: RawPerson;
        destination?: { commit?: { hash?: string } | null };
      }>(pullRequestUrl(ref));
      const destinationCommit = raw.destination?.commit?.hash;
      if (destinationCommit === undefined) {
        throw new Error(`Bitbucket returned no destination commit for pull request ${ref.id}`);
      }
      return {
        id: raw.id,
        title: raw.title ?? "",
        author: toPerson(raw.author),
        destinationCommit,
      };
    },

    async getFileChanges(ref) {
      // The diffstat endpoint answers with a redirect to the same host; fetch follows it.
      const raw = await collect<{
        lines_added?: number | null;
        lines_removed?: number | null;
        old?: { path?: string } | null;
        new?: { path?: string } | null;
      }>(`${pullRequestUrl(ref)}/diffstat?pagelen=${PAGE_LENGTH}`);
      return raw.map((entry) => {
        const change: FileChange = {
          linesAdded: entry.lines_added ?? 0,
          linesRemoved: entry.lines_removed ?? 0,
        };
        if (entry.old?.path !== undefined) {
          change.oldPath = entry.old.path;
        }
        if (entry.new?.path !== undefined) {
          change.newPath = entry.new.path;
        }
        return change;
      });
    },

    async getComments(ref) {
      const raw = await collect<{
        id: number;
        deleted?: boolean;
        content?: { raw?: string };
        user?: RawPerson;
        resolution?: unknown;
      }>(`${pullRequestUrl(ref)}/comments?pagelen=${PAGE_LENGTH}`);
      return raw
        .filter((comment) => comment.deleted !== true)
        .map((comment) => ({
          id: comment.id,
          author: toPerson(comment.user),
          body: comment.content?.raw ?? "",
          resolved: Boolean(comment.resolution),
        }));
    },

    async *listMergedPullRequestIds(repository, authorUuid) {
      // The `state` query parameter is ignored once `q` is present, so merged PRs are picked out
      // here.
      const query = new URLSearchParams({
        q: `author.uuid="${authorUuid}"`,
        sort: "-updated_on",
        pagelen: "50",
        fields: "next,values.id,values.state",
      });
      const url = `${repositoryUrl(repository)}/pullrequests?${query}`;
      for await (const pr of listItems<{ id: number; state?: string }>(url)) {
        if (pr.state === "MERGED") {
          yield pr.id;
        }
      }
    },

    async getFile(repository, commit, path) {
      try {
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        return await (await getResponse(`${repositoryUrl(repository)}/src/${commit}/${encoded}`)).text();
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

function toPerson(raw: RawPerson | undefined): Person {
  const person: Person = {
    uuid: raw?.uuid ?? "",
    name: raw?.display_name ?? raw?.nickname ?? "(unknown)",
  };
  if (raw?.nickname !== undefined) {
    person.nickname = raw.nickname;
  }
  return person;
}

/** Visible ASCII only. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;

/** A Bearer header for `token`, or none. Throws without echoing a token that cannot be a header
 * value, since fetch's own rejection message would contain it. */
function authorizationHeaders(token: string | undefined): Record<string, string> {
  if (!token) {
    return {};
  }
  if (!HEADER_SAFE_TOKEN.test(token)) {
    throw new Error(
      "BITBUCKET_TOKEN contains characters that can't be sent in an HTTP header (such as whitespace or a line break); check its value",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

function httpError(status: number, url: string, hasToken: boolean): HttpError {
  let hint = "";
  if (status === 429) {
    hint = " — rate limited; Bitbucket limits anonymous requests heavily, so set BITBUCKET_TOKEN";
  } else if (status === 401 || status === 403 || status === 404) {
    hint = hasToken
      ? " — check that BITBUCKET_TOKEN can read this repository"
      : " — for a private repository, set BITBUCKET_TOKEN";
  }
  return new HttpError(`Bitbucket API returned ${status} for ${url}${hint}`, status);
}
