import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderrTail } from "../llm/exec.ts";
import type { Exec } from "../llm/types.ts";

/** A shallow copy of one commit of the PR's repository, in a throwaway directory. */
export interface Checkout {
  /** The git repository holding the commit. With {@link worktree}, its files are checked out too. */
  dir: string;
  /** The full hash of the commit. */
  commit: string;
  worktree: boolean;
  /** An empty directory outside {@link dir}, for what a search tool wants to write besides the checkout. */
  scratch: string;
  /** Deletes everything this checkout created. */
  dispose(): Promise<void>;
}

export interface CheckoutRequest {
  /** The repository's clone URL, without credentials. */
  url: string;
  /** The full hash of the commit to fetch. */
  commit: string;
  /** A Bitbucket access token, for a private repository. It is handed to git through the environment only. */
  token?: string | undefined;
  /** Whether to check the files out; a search over the commit's tree needs no files on disk. */
  worktree: boolean;
  timeoutMs: number;
}

const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Visible ASCII only: anything else cannot be a header value. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;

/**
 * The PR's code is written by whoever opened the PR, so nothing in it may run on this machine.
 * Git is therefore run with no system or user config (a user's `url.*.insteadOf`, filters or hooks
 * cannot apply), hooks off, and symbolic links checked out as plain files holding the link text,
 * so that none can point out of the directory.
 */
function gitEnv(path: string | undefined, config: [string, string][]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: path ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Fetches one commit, with no history, into a new temporary directory, and checks it out when
 * `worktree` is set. Bitbucket takes a repository access token as the password of the user
 * `x-token-auth`; a Bearer header is refused by git over HTTPS. The header travels in the
 * environment of the git process, not in its arguments, and is not saved in the repository.
 */
export async function createCheckout(
  exec: Exec,
  request: CheckoutRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Checkout> {
  if (!FULL_HASH.test(request.commit)) {
    throw new Error(`Not a full commit hash: ${JSON.stringify(request.commit)}`);
  }
  if (request.token !== undefined && request.token !== "" && !HEADER_SAFE_TOKEN.test(request.token)) {
    throw new Error("BITBUCKET_TOKEN contains characters that can't be sent in an HTTP header; check its value");
  }

  const root = await mkdtemp(join(tmpdir(), "small-change-checkout-"));
  const dir = join(root, "repo");
  const scratch = join(root, "scratch");
  const dispose = () => rm(root, { recursive: true, force: true });

  const base: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", ""],
    ["advice.detachedHead", "false"],
  ];
  const auth: [string, string][] =
    request.token === undefined || request.token === ""
      ? []
      : [["http.extraHeader", `Authorization: Basic ${Buffer.from(`x-token-auth:${request.token}`).toString("base64")}`]];

  const git = async (args: string[], config: [string, string][], what: string, cwd = dir) => {
    const result = await exec("git", args, {
      cwd,
      env: gitEnv(env.PATH, config),
      timeoutMs: request.timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(`git ${what} failed: ${stderrTail(result.stderr, 3) || `exit code ${result.code}`}`);
    }
    return result;
  };

  try {
    await git(["init", "-q", dir], base, "init", root);
    await git(
      ["fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", request.url, request.commit],
      [...base, ...auth],
      "fetch",
    );
    if (request.worktree) {
      await git(["checkout", "-q", "--detach", "FETCH_HEAD"], [...base, ["core.symlinks", "false"]], "checkout");
    }
    await mkdir(scratch);
    return { dir, commit: request.commit, worktree: request.worktree, scratch, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
