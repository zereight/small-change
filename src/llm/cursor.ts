import { canRun, stderrTail } from "./exec.ts";
import type { ModelInfo, Provider } from "./types.ts";
import { DEFAULT_MODEL } from "./types.ts";

/**
 * Cursor's `agent`, run headless in its read-only `ask` mode, sandboxed, in an empty workspace.
 * The prompt goes on stdin. The effort is part of the model slug (`grok-4.7-xhigh-fast`).
 */
export const cursor: Provider = {
  id: "cursor",
  label: "Cursor agent",
  binary: "agent",
  effortStyle: "slug",
  isInstalled: (exec) => canRun(exec, "agent"),
  async listModels(exec) {
    const result = await exec("agent", ["--list-models"], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      throw new Error(`agent --list-models exited with ${result.code}: ${stderrTail(result.stderr)}`);
    }
    return parseCursorModels(result.stdout);
  },
  suggestedModels: [],
  async run(exec, request) {
    const args = [
      "-p",
      "--mode",
      "ask",
      "--trust",
      "--sandbox",
      "enabled",
      "--output-format",
      "json",
      "--workspace",
      request.workdir,
      ...(request.model === DEFAULT_MODEL ? [] : ["--model", request.model]),
    ];
    const result = await exec("agent", args, {
      cwd: request.workdir,
      env: request.env,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
    });
    const answer = parseCursorOutput(result.stdout);
    if (answer.ok) {
      return answer.text;
    }
    if (answer.error !== undefined) {
      throw new Error(`agent failed: ${answer.error}`);
    }
    throw new Error(`agent exited with ${result.code}: ${stderrTail(result.stderr)}`);
  },
};

const ANSI = /\u001b\[[0-9;]*m/g;
// Zero-width characters that some model labels carry.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Reads `agent --list-models`: a header, then one `slug - Name` line per model. */
export function parseCursorModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.replace(ANSI, "").split("\n")) {
    const match = /^(\S+) - (.*)$/.exec(line.replace(ZERO_WIDTH, "").trim());
    if (match?.[1] !== undefined) {
      models.push({ id: match[1], ...(match[2] ? { label: match[2].trim() } : {}) });
    }
  }
  return models;
}

type CursorAnswer = { ok: true; text: string } | { ok: false; error?: string };

/** Reads `agent -p --output-format json`: one `result` object. */
export function parseCursorOutput(stdout: string): CursorAnswer {
  let parsed: { type?: unknown; result?: unknown; is_error?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || parsed.type !== "result") {
    return { ok: false };
  }
  const text = typeof parsed.result === "string" ? parsed.result : "";
  return parsed.is_error === true ? { ok: false, error: text || "unknown error" } : { ok: true, text };
}
