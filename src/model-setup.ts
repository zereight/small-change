import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  BUDGET_LABELS,
  BUDGET_NAMES,
  BUDGETS,
  type Budget,
  clampEffort,
  retargetSlug,
} from "./llm/budget.ts";
import { agentEnv } from "./llm/exec.ts";
import { PROVIDER_IDS, PROVIDERS } from "./llm/providers.ts";
import { DEFAULT_MODEL, type Effort, type Exec, type ModelInfo, type Provider, type ProviderId } from "./llm/types.ts";
import { ConfigError, isModelId, loadConfig, type ModelChoice, type ModelConfig, type Role, saveConfig } from "./model-config.ts";

export interface SetupIO {
  input: Readable;
  output: Writable;
  /** Whether a person is at the keyboard. Without one, every choice must come from a flag or the saved config. */
  interactive: boolean;
}

export interface SetupFlags {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  budget?: Budget | undefined;
  /** Which model is being chosen; the reviewer when absent. */
  role?: Role | undefined;
  /** For the verifier: delete it from the config instead of choosing one. */
  remove?: boolean | undefined;
  /** Save without asking to confirm. */
  yes: boolean;
  /** Check the choice with a one-word request before saving. */
  verify: boolean;
}

export interface SetupDeps {
  exec: Exec;
  io: SetupIO;
  /** Where the config is read from and written to. */
  configFile: string;
  env: NodeJS.ProcessEnv;
  /** Defaults to the real agent CLIs; tests pass stand-ins. */
  providers?: Record<ProviderId, Provider>;
}

const PROBE_PROMPT = "Reply with exactly: OK";
const PROBE_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 5;

/**
 * Chooses which agent CLI, model and reasoning budget the review runs on, and saves the choice.
 * The choice is for the reviewer, or, with `role: "verifier"`, for the second model that tries to
 * refute the reviewer's P1 and P2 findings; each role is saved without touching the other.
 *
 * 1. Detect the agent CLIs on PATH and the models the account can use.
 * 2. Start from the saved config, if there is one.
 * 3. Ask for the provider, the model and a budget, or take them from flags.
 * 4. Apply the budget: set the effort, or move the effort in a model slug that carries it.
 * 5. Show the result and ask to confirm.
 * 6. Check it with a one-word request, so that a model the account rejects is never saved.
 * 7. Overwrite the config file.
 */
export async function runModelSetup(deps: SetupDeps, flags: SetupFlags): Promise<ModelConfig> {
  const providers = deps.providers ?? PROVIDERS;
  const { interactive } = deps.io;
  const out = (line = "") => deps.io.output.write(`${line}\n`);
  const prompter = createPrompter(deps.io.input, deps.io.output);
  try {
    const role = flags.role ?? "reviewer";
    let saved: ModelConfig | undefined;
    try {
      saved = await loadConfig(deps.configFile);
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      out(`Ignoring the current config: ${error.message}`);
    }
    if (role === "verifier" && saved === undefined) {
      throw new Error("Choose the reviewer first: run `small-change model setup` without --role, then add the verifier");
    }
    if (flags.remove) {
      if (role !== "verifier" || saved === undefined) {
        throw new Error("--remove applies to the verifier only; pass --role verifier");
      }
      if (saved.verifier === undefined) {
        out("No verifier is set; nothing to remove.");
        return saved;
      }
      const { verifier: _removed, ...reviewerOnly } = saved;
      await saveConfig(deps.configFile, reviewerOnly);
      out(`Removed the verifier from ${deps.configFile}`);
      return reviewerOnly;
    }
    // What this role had saved before: the starting point of each choice.
    const current: ModelChoice | undefined = role === "verifier" ? saved?.verifier : saved;

    out("Looking for agent CLIs...");
    const installed = new Map<ProviderId, boolean>(
      await Promise.all(
        PROVIDER_IDS.map(async (id) => [id, await providers[id].isInstalled(deps.exec)] as const),
      ),
    );
    for (const id of PROVIDER_IDS) {
      const provider = providers[id];
      out(`  ${provider.label} (\`${provider.binary}\`): ${installed.get(id) ? "installed" : "not found on PATH"}`);
    }

    if (current !== undefined) {
      out(`Current ${role}: ${describe(current)}`);
    }

    // Provider
    const providerId = await pickProvider(prompter, out, providers, installed, flags.provider, current, interactive);
    const provider = providers[providerId];
    if (!installed.get(providerId)) {
      throw new Error(`\`${provider.binary}\` was not found on PATH; install ${provider.label} and log in first`);
    }

    // Models
    let detected: ModelInfo[] | undefined;
    try {
      detected = await provider.listModels(deps.exec);
    } catch (error) {
      throw new Error(
        `Could not list the models of ${provider.label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const models = detected ?? [...provider.suggestedModels];
    const sameProvider = current?.provider === providerId ? current : undefined;
    let model = await pickModel(prompter, out, provider, models, detected !== undefined, flags.model, sameProvider?.model, interactive);

    // Budget
    const budget = await pickBudget(prompter, out, flags.budget, current?.budget, interactive);

    // Apply the budget
    let effort: Effort | undefined;
    const target = BUDGETS[budget];
    if (provider.effortStyle === "slug") {
      // The effort is part of the slug, so the budget moves it there.
      const retargeted = retargetSlug(model, target, models.map((info) => info.id));
      if (retargeted === undefined && model !== DEFAULT_MODEL) {
        throw new Error(`No variant of ${model} runs at ${target} effort or lower; pick another model or budget`);
      }
      model = retargeted ?? model;
    } else {
      const supported = models.find((info) => info.id === model)?.efforts;
      if (supported === undefined) {
        effort = target;
      } else if (supported.length > 0) {
        effort = clampEffort(target, supported);
        if (effort === undefined) {
          throw new Error(`${model} supports only ${supported.join(", ")}, all above ${target}; pick another model or budget`);
        }
      }
    }

    const choice: ModelChoice = {
      provider: providerId,
      model,
      budget,
      ...(effort === undefined ? {} : { effort }),
    };
    // A role is saved without touching the other one.
    const config: ModelConfig =
      role === "verifier" && saved !== undefined
        ? { ...saved, verifier: choice }
        : { version: 1, ...choice, ...(saved?.verifier === undefined ? {} : { verifier: saved.verifier }) };

    out();
    out(`  Role      ${role}`);
    out(`  Provider  ${provider.label}`);
    out(`  Model     ${model === DEFAULT_MODEL ? `${DEFAULT_MODEL} (the CLI's own default)` : model}`);
    out(`  Budget    ${BUDGET_LABELS[budget]}`);
    out(`  Effort    ${effort ?? (provider.effortStyle === "slug" ? "set by the model slug" : "none: the model has no reasoning levels")}`);
    out(`  Config    ${deps.configFile}`);
    out();

    if (role === "verifier" && saved !== undefined && saved.provider === choice.provider && saved.model === choice.model) {
      out("Note: this is the reviewer's own model. A second look by the same model refutes less than one by another.");
      out();
    }

    if (!flags.yes && interactive) {
      const answer = (await prompter.ask("Save this? [Y/n]: ")).trim().toLowerCase();
      if (answer !== "" && answer !== "y" && answer !== "yes") {
        throw new Error("Not saved");
      }
    }

    if (flags.verify) {
      out("Checking the choice with a one-word request...");
      await probe(deps, provider, choice);
      out("The model answered.");
    }

    await saveConfig(deps.configFile, config);
    out(`Saved ${deps.configFile}`);
    return config;
  } finally {
    prompter.close();
  }
}

/** A one-line description of a config, for messages. */
export function describe(config: ModelChoice): string {
  const effort = config.effort === undefined ? "" : `, effort ${config.effort}`;
  return `${config.provider} / ${config.model} (budget ${config.budget}${effort})`;
}

/** Runs the config's model on a trivial prompt, in an empty directory. */
async function probe(deps: SetupDeps, provider: Provider, config: ModelChoice): Promise<void> {
  const workdir = await mkdtemp(join(tmpdir(), "small-change-probe-"));
  try {
    const answer = await provider.run(deps.exec, {
      prompt: PROBE_PROMPT,
      model: config.model,
      effort: config.effort,
      workdir,
      env: agentEnv(deps.env),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (answer.trim() === "") {
      throw new Error("the answer was empty");
    }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\.+$/, "");
    throw new Error(
      `${provider.label} did not accept ${config.model}: ${reason}. Nothing was saved; run the setup again and pick another model.`,
      { cause: error },
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

type Out = (line?: string) => void;

async function pickProvider(
  prompter: Prompter,
  out: Out,
  providers: Record<ProviderId, Provider>,
  installed: Map<ProviderId, boolean>,
  flag: ProviderId | undefined,
  current: ModelChoice | undefined,
  interactive: boolean,
): Promise<ProviderId> {
  if (flag !== undefined) {
    return flag;
  }
  if (!interactive) {
    return requireValue(current?.provider, "--provider");
  }
  const available = PROVIDER_IDS.filter((id) => installed.get(id));
  if (available.length === 0) {
    throw new Error("No agent CLI was found on PATH; install Claude Code, Cursor's agent or Codex and log in first");
  }
  const fallback = current !== undefined && available.includes(current.provider) ? current.provider : available[0];
  out();
  const choice = await choose(prompter, out, "Provider", available.map((id) => ({ value: id, label: `${providers[id].label} (\`${providers[id].binary}\`)` })), fallback ? available.indexOf(fallback) : 0, false);
  return choice.value as ProviderId;
}

async function pickModel(
  prompter: Prompter,
  out: Out,
  provider: Provider,
  models: ModelInfo[],
  listed: boolean,
  flag: string | undefined,
  saved: string | undefined,
  interactive: boolean,
): Promise<string> {
  if (flag !== undefined) {
    return checkModel(flag, models, listed, provider);
  }
  if (!interactive) {
    return checkModel(requireValue(saved, "--model"), models, listed, provider);
  }
  const items = [
    ...(models.some((info) => info.id === DEFAULT_MODEL) ? [] : [{ value: DEFAULT_MODEL, label: `${DEFAULT_MODEL} (the CLI's own default)` }]),
    ...models.map((info) => ({ value: info.id, label: info.label && info.label !== info.id ? `${info.id} - ${info.label}` : info.id })),
  ];
  const start = Math.max(0, items.findIndex((item) => item.value === saved));
  out();
  const choice = await choose(prompter, out, "Model", items, start, true);
  const picked = choice.custom ?? choice.value;
  return checkModel(picked, models, listed, provider);
}

/** A model must look like a model id, and, when the CLI lists its models, be one of them. */
function checkModel(model: string, models: ModelInfo[], listed: boolean, provider: Provider): string {
  if (!isModelId(model)) {
    throw new Error(`"${model}" is not a valid model id`);
  }
  if (listed && model !== DEFAULT_MODEL && !models.some((info) => info.id === model)) {
    throw new Error(`${provider.label} does not list the model "${model}"; run \`small-change model list --provider ${provider.id}\` to see the ones it does`);
  }
  return model;
}

async function pickBudget(
  prompter: Prompter,
  out: Out,
  flag: Budget | undefined,
  saved: Budget | undefined,
  interactive: boolean,
): Promise<Budget> {
  if (flag !== undefined) {
    return flag;
  }
  if (!interactive) {
    return requireValue(saved, "--budget");
  }
  out();
  out(saved === undefined ? "`large` matches the defaults." : `Current budget: ${saved}.`);
  const items = BUDGET_NAMES.map((name) => ({ value: name, label: BUDGET_LABELS[name] }));
  const start = items.findIndex((item) => item.value === (saved ?? "large"));
  const choice = await choose(prompter, out, "Budget", items, start, false);
  return choice.value as Budget;
}

function requireValue<T>(value: T | undefined, flag: string): T {
  if (value === undefined) {
    throw new Error(`Nothing to choose ${flag} from: pass ${flag}, or run the setup in a terminal`);
  }
  return value;
}

interface Choice {
  value: string;
  /** A name typed that is not on the list, when custom names are allowed. */
  custom?: string;
}

/**
 * Shows a numbered menu and reads a choice: a number, Enter for the default, or text to filter
 * the list (and, with `allowCustom`, to name an item that is not on it).
 */
async function choose(
  prompter: Prompter,
  out: Out,
  title: string,
  items: { value: string; label: string }[],
  defaultIndex: number,
  allowCustom: boolean,
): Promise<Choice> {
  let shown = items;
  let shownDefault = defaultIndex;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    shown.forEach((item, index) => out(`  ${index + 1}. ${item.label}`));
    const hint = allowCustom ? " (a number, part of a name to filter, or a full name)" : "";
    const answer = (await prompter.ask(`${title} [${shownDefault + 1}]${hint}: `)).trim();
    if (answer === "") {
      const item = shown[shownDefault];
      if (item !== undefined) {
        return { value: item.value };
      }
    } else if (/^\d+$/.test(answer)) {
      const item = shown[Number(answer) - 1];
      if (item !== undefined) {
        return { value: item.value };
      }
      out(`Pick a number from 1 to ${shown.length}.`);
    } else {
      const exact = items.find((item) => item.value === answer);
      if (exact !== undefined) {
        return { value: exact.value };
      }
      const matches = items.filter((item) => item.label.toLowerCase().includes(answer.toLowerCase()));
      if (matches.length === 1 && matches[0] !== undefined) {
        return { value: matches[0].value };
      }
      if (matches.length > 1) {
        shown = matches;
        shownDefault = 0;
        continue;
      }
      if (allowCustom) {
        return { value: answer, custom: answer };
      }
      out(`Nothing matches "${answer}".`);
    }
  }
  throw new Error(`No valid choice for ${title} after ${MAX_ATTEMPTS} tries`);
}

interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

/** Reads lines one at a time from `input`, so a script of answers works the same as a keyboard. */
function createPrompter(input: Readable, output: Writable): Prompter {
  const rl = createInterface({ input, terminal: Boolean((input as { isTTY?: boolean }).isTTY) });
  const queued: string[] = [];
  const waiting: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) {
      waiter.resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiting.splice(0)) {
      waiter.reject(new Error("The input ended before the setup finished"));
    }
  });
  return {
    ask(question) {
      output.write(question);
      const line = queued.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (closed) {
        return Promise.reject(new Error("The input ended before the setup finished"));
      }
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close: () => rl.close(),
  };
}

/** The saved config as text, or a pointer to the setup when there is none. */
export async function describeConfig(configFile: string): Promise<string> {
  const config = await loadConfig(configFile);
  return config === undefined
    ? `No model is configured. Run \`small-change model setup\`. (${configFile})`
    : `${describe(config)}\n${
        config.verifier === undefined
          ? "verifier: none (run `small-change model setup --role verifier` to add one)"
          : `verifier: ${describe(config.verifier)}`
      }\n${configFile}`;
}

/** The models of every installed agent CLI, or of one. */
export async function listModels(
  deps: Pick<SetupDeps, "exec" | "providers">,
  only: ProviderId | undefined,
  out: Out,
): Promise<void> {
  const providers = deps.providers ?? PROVIDERS;
  for (const id of only === undefined ? PROVIDER_IDS : [only]) {
    const provider = providers[id];
    if (!(await provider.isInstalled(deps.exec))) {
      out(`${provider.label} (\`${provider.binary}\`): not found on PATH`);
      continue;
    }
    let models: ModelInfo[] | undefined;
    try {
      models = await provider.listModels(deps.exec);
    } catch (error) {
      out(`${provider.label}: could not list models: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    out(`${provider.label} (\`${provider.binary}\`)${models === undefined ? ": cannot list models; suggestions" : ""}`);
    for (const info of models ?? provider.suggestedModels) {
      out(`  ${info.id}${info.label && info.label !== info.id ? ` - ${info.label}` : ""}${info.efforts ? ` [${info.efforts.length > 0 ? info.efforts.join(", ") : "no reasoning levels"}]` : ""}`);
    }
  }
}
