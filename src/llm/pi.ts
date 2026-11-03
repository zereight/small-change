import { canRun, stderrTail } from "./exec.ts";
import type { ModelInfo, Provider } from "./types.ts";
import { DEFAULT_MODEL } from "./types.ts";

/**
 * The `pi` coding agent, run headless with `-p`: every tool, extension, skill, prompt template,
 * context file and MCP server off, no saved session, and the prompt on stdin. Extensions are off
 * so that none of them can act on the PR's text, which also means the models that only an
 * extension provides (a `claude-bridge` provider, say) are not available here. A model is
 * `provider/model`, as in `pi --list-models`.
 */
export const pi: Provider = {
  id: "pi",
  label: "Pi",
  binary: "pi",
  effortStyle: "flag",
  isInstalled: (exec) => canRun(exec, "pi"),
  async listModels(exec) {
    const result = await exec("pi", [...ISOLATION, "--list-models"], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      throw new Error(`pi --list-models exited with ${result.code}: ${stderrTail(result.stderr)}`);
    }
    return parsePiModels(result.stdout);
  },
  suggestedModels: [{ id: DEFAULT_MODEL, label: "the model chosen in Pi's settings" }],
  async run(exec, request) {
    const args = [
      "-p",
      ...ISOLATION,
      ...(request.model === DEFAULT_MODEL ? [] : ["--model", request.model]),
      ...(request.effort === undefined ? [] : ["--thinking", request.effort]),
    ];
    const result = await exec("pi", args, {
      cwd: request.workdir,
      env: request.env,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
    });
    // Text mode exits non-zero on a model or API error; the JSON mode would exit 0 on one.
    if (result.code !== 0) {
      throw new Error(`pi exited with ${result.code}: ${piError(result.stderr)}`);
    }
    const text = result.stdout.trim();
    if (text === "") {
      throw new Error(`pi printed no answer: ${piError(result.stderr)}`);
    }
    return text;
  },
};

/** What turns off everything in Pi that could act on, or add to, the prompt. */
const ISOLATION = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
];

/**
 * Reads `pi --list-models`: a header row, then `provider model context max-out thinking images`
 * per model. The model id is `provider/model`. A model without thinking has no reasoning levels.
 */
export function parsePiModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const [provider, model, , , thinking] = columns;
    if (columns.length < 6 || provider === undefined || model === undefined || provider === "provider") {
      continue;
    }
    models.push({
      id: `${provider}/${model}`,
      label: `${model} (${provider})`,
      ...(thinking === "no" ? { efforts: [] } : {}),
    });
  }
  return models;
}

/** Pi's error from stderr, without the warnings about model patterns in the user's settings. */
function piError(stderr: string): string {
  return stderrTail(
    stderr
      .split("\n")
      .filter((line) => !line.startsWith("Warning: "))
      .join("\n"),
  );
}
