import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRun, stderrTail } from "./exec.ts";
import { isEffort } from "./budget.ts";
import type { Effort, ModelInfo, Provider } from "./types.ts";
import { DEFAULT_MODEL } from "./types.ts";

/**
 * OpenAI's `codex exec`, run headless with a read-only sandbox, no saved session, in an empty
 * directory. The prompt goes on stdin; the final message is read from a file. Models come from
 * `codex debug models`, which also lists models a ChatGPT login rejects, so a choice is checked
 * with a probe run.
 */
export const codex: Provider = {
  id: "codex",
  label: "OpenAI Codex",
  binary: "codex",
  effortStyle: "flag",
  isInstalled: (exec) => canRun(exec, "codex"),
  async listModels(exec) {
    const result = await exec("codex", ["debug", "models"], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      throw new Error(`codex debug models exited with ${result.code}: ${stderrTail(result.stderr)}`);
    }
    return parseCodexModels(result.stdout);
  },
  suggestedModels: [],
  async run(exec, request) {
    // The answer file lives outside the agent's workdir, so the sandboxed agent cannot touch it.
    const answerDir = await mkdtemp(join(tmpdir(), "small-change-codex-"));
    const answerFile = join(answerDir, "answer.txt");
    try {
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "read-only",
        "-C",
        request.workdir,
        "--color",
        "never",
        "--output-last-message",
        answerFile,
        ...(request.model === DEFAULT_MODEL ? [] : ["-m", request.model]),
        ...(request.effort === undefined ? [] : ["-c", `model_reasoning_effort="${request.effort}"`]),
        "-",
      ];
      const result = await exec("codex", args, {
        cwd: request.workdir,
        env: request.env,
        input: request.prompt,
        timeoutMs: request.timeoutMs,
      });
      if (result.code !== 0) {
        throw new Error(`codex failed: ${codexError(result.stderr)}`);
      }
      return (await readFile(answerFile, "utf8")).trim();
    } finally {
      await rm(answerDir, { recursive: true, force: true });
    }
  },
};

/** Reads `codex debug models`: the catalog, minus the models it hides. */
export function parseCodexModels(stdout: string): ModelInfo[] {
  const catalog = JSON.parse(stdout) as {
    models?: {
      slug?: string;
      display_name?: string;
      visibility?: string;
      supported_reasoning_levels?: (string | { effort?: string })[];
    }[];
  };
  const models: ModelInfo[] = [];
  for (const entry of catalog.models ?? []) {
    if (entry.slug === undefined || entry.visibility === "hide") {
      continue;
    }
    const efforts = (entry.supported_reasoning_levels ?? [])
      .map((level) => (typeof level === "string" ? level : level.effort))
      .filter((level): level is Effort => level !== undefined && isEffort(level));
    models.push({
      id: entry.slug,
      ...(entry.display_name ? { label: entry.display_name } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
    });
  }
  return models;
}

/** The API's own message from codex's log (`ERROR: {...}`), else the log's last lines. */
export function codexError(stderr: string): string {
  const line = stderr
    .split("\n")
    .findLast((candidate) => candidate.startsWith("ERROR: "));
  if (line !== undefined) {
    try {
      const message = (JSON.parse(line.slice("ERROR: ".length)) as { error?: { message?: string } })
        .error?.message;
      if (message) {
        return message;
      }
    } catch {
      return line.slice("ERROR: ".length);
    }
  }
  return stderrTail(stderr);
}
