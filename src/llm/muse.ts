import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRun, stderrTail } from "./exec.ts";
import type { Provider } from "./types.ts";
import { DEFAULT_MODEL } from "./types.ts";

/**
 * Muse Code, run headless with `muse exec --json` in the bare `empty` preset, with shell, file
 * writes, web tools and questions off, no session log, and none of the user's other tools' rules
 * or skills. The prompt goes in a file outside the workspace, and the answer is read from the run's
 * final event. The CLI has no way to list models, so the one that is known to work is suggested
 * and a probe run checks any other choice.
 */
export const muse: Provider = {
  id: "muse",
  label: "Muse Code",
  binary: "muse",
  effortStyle: "flag",
  isInstalled: (exec) => canRun(exec, "muse"),
  listModels: async () => undefined,
  suggestedModels: [
    { id: DEFAULT_MODEL, label: "the CLI's own default" },
    { id: "muse-spark-1.3" },
  ],
  async run(exec, request) {
    const promptDir = await mkdtemp(join(tmpdir(), "small-change-muse-"));
    const promptFile = join(promptDir, "prompt.txt");
    try {
      await writeFile(promptFile, request.prompt, "utf8");
      const args = [
        "exec",
        "--json",
        "--prompt-file",
        promptFile,
        "--workspace",
        request.workdir,
        "--preset",
        "empty",
        "--no-session-log",
        "--disable-shell",
        "--disable-write",
        "--disable-web-tools",
        "--disable-request-user-input",
        "--disable-reminders",
        "--no-foreign-personal-context",
        ...(request.model === DEFAULT_MODEL ? [] : ["--model", request.model]),
        ...(request.effort === undefined ? [] : ["--reasoning-effort", request.effort]),
      ];
      const result = await exec("muse", args, {
        cwd: request.workdir,
        env: request.env,
        timeoutMs: request.timeoutMs,
      });
      // The run's own failure reason is in the events, so read those before the exit code.
      const answer = parseMuseOutput(result.stdout);
      if (answer.ok) {
        return answer.text;
      }
      if (answer.error !== undefined) {
        throw new Error(`muse failed: ${answer.error}`);
      }
      throw new Error(`muse exited with ${result.code}: ${stderrTail(result.stderr)}`);
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  },
};

type MuseAnswer = { ok: true; text: string } | { ok: false; error?: string };

/**
 * Reads `muse exec --json`: one JSON event per line. The run ends with a `run.terminal.*` event
 * whose `terminal` is `completed` (its `text` is the answer) or `failed` (its `reason` says why).
 */
export function parseMuseOutput(stdout: string): MuseAnswer {
  let terminal: { terminal?: unknown; text?: unknown; reason?: unknown } | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { payload_type?: unknown; payload?: object };
      if (typeof event.payload_type === "string" && event.payload_type.startsWith("run.terminal.")) {
        terminal = event.payload;
      }
    } catch {
      // not an event
    }
  }
  if (terminal === undefined) {
    return { ok: false };
  }
  if (terminal.terminal === "completed") {
    return { ok: true, text: typeof terminal.text === "string" ? terminal.text : "" };
  }
  const reason = typeof terminal.reason === "string" && terminal.reason !== "" ? terminal.reason : undefined;
  return { ok: false, error: reason ?? `the run ended as ${JSON.stringify(terminal.terminal)}` };
}
