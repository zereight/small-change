import { parseArgs } from "node:util";
import { isBudget } from "./llm/budget.ts";
import { isProviderId } from "./llm/providers.ts";
import type { Budget } from "./llm/budget.ts";
import type { ProviderId } from "./llm/types.ts";
import { UsageError } from "./options.ts";

export const MODEL_USAGE = `Usage: small-change model <command> [options]

Chooses which agent CLI, model and reasoning budget "small-change review" runs on.

Commands:
  setup                    Detect the agent CLIs and their models, choose, check and save
  show                     Print the saved choice
  list                     Print the models of the installed agent CLIs

Options for setup:
  --provider <id>          claude, cursor or codex
  --model <id>             A model id, or "default" for the CLI's own default
  --budget <name>          unlimited (max effort), large (xhigh), medium (high) or small (medium)
  --yes                    Save without asking to confirm
  --no-verify              Do not check the choice with a one-word request before saving
  --config <file>          Read and write this file instead of the default

Options for list:
  --provider <id>          Only this agent CLI

Without flags, "setup" asks for each choice. In a script, pass --provider, --model and --budget.
The default file is $XDG_CONFIG_HOME/small-change/config.json, else ~/.config/small-change/config.json.`;

export type ModelCommand =
  | { command: "help" }
  | { command: "show"; config: string | undefined }
  | { command: "list"; provider: ProviderId | undefined }
  | {
      command: "setup";
      provider: ProviderId | undefined;
      model: string | undefined;
      budget: Budget | undefined;
      yes: boolean;
      verify: boolean;
      config: string | undefined;
    };

/** Parses the arguments after `model`. Throws {@link UsageError}. */
export function parseModelArgs(argv: string[]): ModelCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return { command: "help" };
  }
  const [command, ...extra] = positionals;
  if (command === undefined) {
    throw new UsageError("Missing command: setup, show or list");
  }
  if (extra.length > 0) {
    throw new UsageError(`Unexpected extra arguments: ${extra.join(" ")}`);
  }
  const provider = values.provider === undefined ? undefined : providerId(values.provider);

  switch (command) {
    case "setup": {
      const budget = values.budget;
      if (budget !== undefined && !isBudget(budget)) {
        throw new UsageError(`Invalid --budget "${budget}": expected unlimited, large, medium or small`);
      }
      return {
        command,
        provider,
        model: values.model,
        budget,
        yes: values.yes ?? false,
        verify: values.verify ?? true,
        config: values.config,
      };
    }
    case "show":
      return { command, config: values.config };
    case "list":
      return { command, provider };
    default:
      throw new UsageError(`Unknown command "${command}": expected setup, show or list`);
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      budget: { type: "string" },
      yes: { type: "boolean", short: "y" },
      verify: { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function providerId(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new UsageError(`Invalid --provider "${value}": expected claude, cursor or codex`);
  }
  return value;
}
