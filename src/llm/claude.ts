import { canRun, stderrTail } from "./exec.ts";
import type { Provider } from "./types.ts";
import { DEFAULT_MODEL } from "./types.ts";

/**
 * Claude Code, run headless: `claude -p` with every tool off, no saved session and no settings
 * files, so the only input is the prompt on stdin. The CLI cannot list models, so aliases are
 * suggested and a probe run checks the choice.
 */
export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  isInstalled: (exec) => canRun(exec, "claude"),
  listModels: async () => undefined,
  suggestedModels: [
    { id: DEFAULT_MODEL, label: "the CLI's own default" },
    { id: "fable", label: "latest Fable" },
    { id: "opus", label: "latest Opus" },
    { id: "sonnet", label: "latest Sonnet" },
    { id: "haiku", label: "latest Haiku" },
  ],
  async run(exec, request) {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--setting-sources",
      "",
      ...(request.model === DEFAULT_MODEL ? [] : ["--model", request.model]),
      ...(request.effort === undefined ? [] : ["--effort", request.effort]),
    ];
    const result = await exec("claude", args, {
      cwd: request.workdir,
      env: request.env,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
    });
    // The CLI reports its own errors in the JSON, so read that first.
    const answer = parseClaudeOutput(result.stdout);
    if (answer.ok) {
      return answer.text;
    }
    if (answer.error !== undefined) {
      throw new Error(`claude failed: ${answer.error}`);
    }
    throw new Error(`claude exited with ${result.code}: ${stderrTail(result.stderr)}`);
  },
};

type ClaudeAnswer = { ok: true; text: string } | { ok: false; error?: string };

/**
 * Reads `claude -p --output-format json`. Current versions print an array of events that ends
 * with a `result` event; older ones print that event alone.
 */
export function parseClaudeOutput(stdout: string): ClaudeAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const final = events.findLast(
    (event): event is { type: string; result?: unknown; is_error?: unknown } =>
      typeof event === "object" && event !== null && (event as { type?: unknown }).type === "result",
  );
  if (final === undefined) {
    return { ok: false };
  }
  const text = typeof final.result === "string" ? final.result : "";
  return final.is_error === true ? { ok: false, error: text || "unknown error" } : { ok: true, text };
}
