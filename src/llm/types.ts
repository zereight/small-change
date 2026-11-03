/** Reasoning effort, from the cheapest to the most thorough. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type ProviderId = "claude" | "cursor" | "codex" | "pi" | "muse";

export interface ModelInfo {
  /** What is passed to the agent CLI as the model. */
  id: string;
  label?: string;
  /** The efforts this model accepts, when the CLI says. Empty: the model has no reasoning levels. */
  efforts?: readonly Effort[];
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  /** Null when the child was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program. Resolves for any exit code; rejects when the program cannot be started, runs
 * past `timeoutMs`, or prints more than the output cap.
 */
export type Exec = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface RunRequest {
  prompt: string;
  /** A model id, or `default` for the CLI's own default. */
  model: string;
  effort?: Effort | undefined;
  /** An empty directory the agent runs in. */
  workdir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** An agent CLI that is driven headlessly: no API key, just a logged-in CLI. */
export interface Provider {
  id: ProviderId;
  label: string;
  /** How the reasoning effort reaches the CLI: a flag, or inside the model slug. */
  effortStyle: "flag" | "slug";
  /** The executable on PATH. */
  binary: string;
  isInstalled(exec: Exec): Promise<boolean>;
  /** The models the account can use, or undefined when the CLI has no way to list them. */
  listModels(exec: Exec): Promise<ModelInfo[] | undefined>;
  /** Offered when {@link listModels} cannot list. */
  suggestedModels: readonly ModelInfo[];
  /** Runs one prompt with no tools and returns the model's text answer. */
  run(exec: Exec, request: RunRequest): Promise<string>;
}

/** The model alias that means "do not pass a model: use the CLI's own default". */
export const DEFAULT_MODEL = "default";
