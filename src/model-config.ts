import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Budget, isBudget, isEffort } from "./llm/budget.ts";
import { isProviderId } from "./llm/providers.ts";
import type { Effort, ProviderId } from "./llm/types.ts";

/** Which agent CLI, model and reasoning budget the review runs on. */
export interface ModelConfig {
  version: 1;
  provider: ProviderId;
  /** A model id, or `default` for the CLI's own default. */
  model: string;
  budget: Budget;
  /** The effort passed to the CLI. Absent when the model slug carries it (Cursor). */
  effort?: Effort;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** `$XDG_CONFIG_HOME/small-change/config.json`, else `~/.config/small-change/config.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), ".config");
  return join(base, "small-change", "config.json");
}

/** A model id goes to the agent CLI as an argument, so it may not look like an option. Brackets
 * and commas are allowed for Cursor's `claude-opus-4-8[effort=high]` form. */
const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\],=+-]*$/;

export function isModelId(value: string): boolean {
  return MODEL_ID.test(value);
}

/** The config at `path`, or undefined when there is none. Throws {@link ConfigError} on a file
 * that cannot be used, naming the file. */
export async function loadConfig(path: string): Promise<ModelConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON; fix it or run \`small-change model setup\``);
  }
  const problem = validate(raw);
  if (typeof problem === "string") {
    throw new ConfigError(`${path}: ${problem}; fix it or run \`small-change model setup\``);
  }
  return problem;
}

/** Writes the whole file, through a temporary file, so a re-run never leaves half a config. */
export async function saveConfig(path: string, config: ModelConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** The config when `raw` is one, else what is wrong with it. */
function validate(raw: unknown): ModelConfig | string {
  if (typeof raw !== "object" || raw === null) {
    return "expected a JSON object";
  }
  const { version, provider, model, budget, effort } = raw as Record<string, unknown>;
  if (version !== 1) {
    return `unsupported version ${JSON.stringify(version)}`;
  }
  if (typeof provider !== "string" || !isProviderId(provider)) {
    return `unknown provider ${JSON.stringify(provider)}`;
  }
  if (typeof model !== "string" || !isModelId(model)) {
    return `invalid model ${JSON.stringify(model)}`;
  }
  if (typeof budget !== "string" || !isBudget(budget)) {
    return `unknown budget ${JSON.stringify(budget)}`;
  }
  if (effort !== undefined && (typeof effort !== "string" || !isEffort(effort))) {
    return `unknown effort ${JSON.stringify(effort)}`;
  }
  return { version, provider, model, budget, ...(effort === undefined ? {} : { effort }) };
}
