import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultExec } from "../src/llm/exec.ts";
import type { Exec, ExecOptions } from "../src/llm/types.ts";
import { createCheckout } from "../src/review/checkout.ts";

const HASH = "a".repeat(40);
const REQUEST = { url: "https://bitbucket.org/team/repo.git", commit: HASH, worktree: false, timeoutMs: 1000 };

interface Call {
  file: string;
  args: readonly string[];
  options: ExecOptions;
}

/** An exec that records the calls and answers each with the next scripted result. */
function recorder(results: { code: number; stderr?: string }[] = []) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    const result = results[calls.length - 1] ?? { code: 0 };
    return { code: result.code, stdout: "", stderr: result.stderr ?? "" };
  };
  return { exec, calls };
}

const config = (call: Call): Record<string, string> => {
  const env = call.options.env ?? {};
  const out: Record<string, string> = {};
  for (let index = 0; index < Number(env.GIT_CONFIG_COUNT ?? 0); index++) {
    out[env[`GIT_CONFIG_KEY_${index}`] ?? ""] = env[`GIT_CONFIG_VALUE_${index}`] ?? "";
  }
  return out;
};

describe("createCheckout with a recorded git", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) {
      await rm(dirname(dir), { recursive: true, force: true });
    }
  });

  it("refuses a commit that is not a full hash, and a token that cannot be a header value", async () => {
    const { exec, calls } = recorder();
    for (const commit of ["abc123", "a".repeat(39), "g".repeat(40), "--upload-pack=x", `${HASH}\n`]) {
      await assert.rejects(createCheckout(exec, { ...REQUEST, commit }), /Not a full commit hash/);
    }
    await assert.rejects(createCheckout(exec, { ...REQUEST, token: "to ken" }), /can't be sent in an HTTP header/);
    await assert.rejects(createCheckout(exec, { ...REQUEST, token: "tok\nen" }), /can't be sent in an HTTP header/);
    assert.equal(calls.length, 0);
  });

  it("inits and fetches one commit with no history and no tags; a search over the tree needs no checkout", async () => {
    const { exec, calls } = recorder();
    const checkout = await createCheckout(exec, REQUEST, { PATH: "/usr/bin" });
    made.push(checkout.dir);
    assert.deepEqual(calls.map((call) => call.args[0]), ["init", "fetch"]);
    assert.deepEqual(calls[1]?.args, ["fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", REQUEST.url, HASH]);
    assert.equal(calls[1]?.options.cwd, checkout.dir);
    assert.equal(checkout.commit, HASH);
    assert.equal(checkout.worktree, false);
    assert.notEqual(dirname(checkout.scratch), checkout.dir);
    assert.equal((await stat(checkout.scratch)).isDirectory(), true);
  });

  it("runs git with no system or user config, no hooks, no prompts and no credential helper, and only PATH from the caller", async () => {
    const { exec, calls } = recorder();
    const checkout = await createCheckout(exec, REQUEST, { PATH: "/usr/bin", HOME: "/home/x", BITBUCKET_TOKEN: "secret", GIT_SSH_COMMAND: "evil" });
    made.push(checkout.dir);
    for (const call of calls) {
      const env = call.options.env ?? {};
      assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
      assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(env.PATH, "/usr/bin");
      assert.equal(env.HOME, undefined);
      assert.equal(env.GIT_SSH_COMMAND, undefined);
      assert.equal(env.BITBUCKET_TOKEN, undefined);
      assert.equal(config(call)["core.hooksPath"], "/dev/null");
      assert.equal(config(call)["credential.helper"], "");
    }
  });

  it("sends the token as the x-token-auth password in the environment, never in the arguments, and only to the fetch", async () => {
    const { exec, calls } = recorder();
    const token = "tok-123_ABC";
    const checkout = await createCheckout(exec, { ...REQUEST, token, worktree: true });
    made.push(checkout.dir);
    const expected = `Authorization: Basic ${Buffer.from(`x-token-auth:${token}`).toString("base64")}`;
    const fetch = calls.find((call) => call.args[0] === "fetch");
    assert.equal(config(fetch as Call)["http.extraHeader"], expected);
    for (const call of calls) {
      assert.ok(!call.args.join(" ").includes(token), "token in arguments");
      assert.ok(!JSON.stringify(call.args).includes(Buffer.from(`x-token-auth:${token}`).toString("base64")));
      if (call !== fetch) {
        assert.equal(config(call)["http.extraHeader"], undefined);
      }
    }
  });

  it("sends no header for a public repository", async () => {
    const { exec, calls } = recorder();
    const checkout = await createCheckout(exec, { ...REQUEST, token: "" });
    made.push(checkout.dir);
    assert.equal(config(calls[1] as Call)["http.extraHeader"], undefined);
  });

  it("checks the files out detached with links as plain files, only when asked", async () => {
    const { exec, calls } = recorder();
    const checkout = await createCheckout(exec, { ...REQUEST, worktree: true });
    made.push(checkout.dir);
    assert.deepEqual(calls.map((call) => call.args[0]), ["init", "fetch", "checkout"]);
    assert.deepEqual(calls[2]?.args, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
    assert.equal(config(calls[2] as Call)["core.symlinks"], "false");
    assert.equal(checkout.worktree, true);
  });

  it("deletes what it made and names the step when git fails, without echoing the token", async () => {
    const { exec, calls } = recorder([{ code: 0 }, { code: 128, stderr: "fatal: could not read Username for 'https://bitbucket.org'\nfatal: more" }]);
    await assert.rejects(createCheckout(exec, { ...REQUEST, token: "tok-123" }), (error: Error) => {
      assert.match(error.message, /git fetch failed: fatal: could not read Username/);
      assert.ok(!error.message.includes("tok-123"));
      return true;
    });
    const root = dirname(calls[0]?.args.at(-1) as string);
    await assert.rejects(stat(root), /ENOENT/);
  });

  it("says the exit code when git prints nothing", async () => {
    const { exec } = recorder([{ code: 7 }]);
    await assert.rejects(createCheckout(exec, REQUEST), /git init failed: exit code 7/);
  });

  it("dispose deletes the directory", async () => {
    const { exec } = recorder();
    const checkout = await createCheckout(exec, REQUEST);
    await checkout.dispose();
    await assert.rejects(stat(dirname(checkout.dir)), /ENOENT/);
    await checkout.dispose();
  });
});

describe("createCheckout with a real git", () => {
  let source: string;
  let commit: string;
  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), "sc-checkout-src-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: source, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q");
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src", "a.ts"), "export const answer = 42;\n");
    await writeFile(join(source, ".eslintrc.js"), "module.exports = {};\n");
    await symlink("/etc/hosts", join(source, "link"));
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    await writeFile(join(source, "src", "a.ts"), "export const answer = 43;\n");
    git("commit", "-q", "-am", "two");
    commit = git("rev-parse", "HEAD").trim();
  });
  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
  });

  it("fetches one commit without history", async () => {
    const checkout = await createCheckout(defaultExec, { url: `file://${source}`, commit, worktree: false, timeoutMs: 60_000 });
    try {
      const log = execFileSync("git", ["log", "--format=%H", "FETCH_HEAD"], { cwd: checkout.dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim().split("\n");
      assert.deepEqual(log, [commit]);
      const blob = execFileSync("git", ["cat-file", "blob", `${commit}:src/a.ts`], { cwd: checkout.dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
      assert.equal(blob, "export const answer = 43;\n");
    } finally {
      await checkout.dispose();
    }
  });

  it("checks out files, with a link as a plain file holding its target, so it cannot lead out of the directory", async () => {
    const checkout = await createCheckout(defaultExec, { url: `file://${source}`, commit, worktree: true, timeoutMs: 60_000 });
    try {
      assert.equal(await readFile(join(checkout.dir, "src", "a.ts"), "utf8"), "export const answer = 43;\n");
      assert.equal(await readFile(join(checkout.dir, ".eslintrc.js"), "utf8"), "module.exports = {};\n");
      const info = await lstat(join(checkout.dir, "link"));
      assert.equal(info.isSymbolicLink(), false);
      assert.equal(await readFile(join(checkout.dir, "link"), "utf8"), "/etc/hosts");
    } finally {
      await checkout.dispose();
    }
  });

  it("fails for a commit the repository does not have, and leaves nothing behind", async () => {
    await assert.rejects(createCheckout(defaultExec, { url: `file://${source}`, commit: "b".repeat(40), worktree: false, timeoutMs: 60_000 }), /git fetch failed/);
  });
});
