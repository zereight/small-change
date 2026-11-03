export interface PullRequestRef {
  workspace: string;
  repo: string;
  id: number;
}

// Bitbucket Cloud only: the API host (and so where the token goes) follows from this fixed host.
const PR_URL = /^https:\/\/bitbucket\.org\/([^/?#\s]+)\/([^/?#\s]+)\/pull-requests\/([1-9]\d{0,9})\/?$/;

// Workspace and repository slugs go into API URLs as they are, so only plain segments are allowed.
const SLUG = /^[A-Za-z0-9._-]+$/;

/**
 * Parses `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`. A tab suffix such as
 * `/diff`, a query or a fragment makes the URL invalid.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const [, workspace, repo, id] = PR_URL.exec(url) ?? [];
  if (workspace === undefined || repo === undefined || id === undefined) {
    return undefined;
  }
  const isPlain = (slug: string) => SLUG.test(slug) && slug !== "." && slug !== "..";
  if (!isPlain(workspace) || !isPlain(repo)) {
    return undefined;
  }
  return { workspace, repo, id: Number(id) };
}
