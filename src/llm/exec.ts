import { spawn } from "node:child_process";
import type { Exec } from "./types.ts";

/** A reply or log longer than this is a runaway process, not an answer. */
const MAX_OUTPUT_CHARS = 20_000_000;

export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (action: () => void) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        action();
      }
    };
    const stop = (error: Error) =>
      finish(() => {
        child.kill("SIGKILL");
        reject(error);
      });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => stop(new Error(`${file} did not finish within ${options.timeoutMs} ms`)),
            options.timeoutMs,
          );

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stop(new Error(`${file} printed more than ${MAX_OUTPUT_CHARS} characters`));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_CHARS);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(error.code === "ENOENT" ? new Error(`${file} was not found on PATH`) : error),
      ),
    );
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    // A child that exits before reading its input closes the pipe; its exit code says why.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/** Whether `file --version` runs and exits cleanly. */
export async function canRun(exec: Exec, file: string): Promise<boolean> {
  try {
    return (await exec(file, ["--version"], { timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
}

/** The environment an agent CLI runs in: ours, without anything that carries a Bitbucket credential.
 * The agent reads untrusted PR text, so it must never hold the token that can post comments. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("BITBUCKET_")));
}

/** The last few lines of a program's stderr, for an error message. */
export function stderrTail(stderr: string, lines = 6): string {
  return stderr.trim().split("\n").slice(-lines).join("\n");
}
