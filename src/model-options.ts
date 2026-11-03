import { parseArgs } from "node:util";
import { isBudget } from "./llm/budget.ts";
import { isProviderId, PROVIDER_IDS } from "./llm/providers.ts";
import type { Budget } from "./llm/budget.ts";
import type { ProviderId } from "./llm/types.ts";
import { isRole, ROLES, type Role } from "./model-config.ts";
import { UsageError } from "./options.ts";

export const MODEL_USAGE = `Usage: small-change model <command> [options]

Chooses which agent CLI, model and reasoning budget "small-change review" runs on, and,
optionally, a second model (the verifier) that tries to refute each P1 and P2 it reports.

Commands:
  setup                    Detect the agent CLIs and their models, choose, check and save
  show                     Print the saved choice
  list                     Print the models of the installed agent CLIs

Options for setup:
  --role <name>            reviewer (default) or verifier. Choose the reviewer first. Use a model
                           other than the reviewer's: a second look by the same model refutes less
  --remove                 With --role verifier: delete the verifier from the config
  --provider <id>          ${PROVIDER_IDS.join(", ")}
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
      role: Role;
      remove: boolean;
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
      const role = values.role ?? "reviewer";
      if (!isRole(role)) {
        throw new UsageError(`Invalid --role "${role}": expected ${ROLES.join(" or ")}`);
      }
      const remove = values.remove ?? false;
      if (remove && role !== "verifier") {
        throw new UsageError("--remove applies to the verifier only: pass --role verifier");
      }
      if (remove && (provider !== undefined || values.model !== undefined || budget !== undefined)) {
        throw new UsageError("--remove cannot be combined with --provider, --model or --budget");
      }
      return {
        command,
        provider,
        model: values.model,
        budget,
        role,
        remove,
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
      role: { type: "string" },
      remove: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      verify: { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function providerId(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new UsageError(`Invalid --provider "${value}": expected one of ${PROVIDER_IDS.join(", ")}`);
  }
  return value;
}
