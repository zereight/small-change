#!/usr/bin/env node
import { createBitbucket } from "./bitbucket.ts";
import { evaluate } from "./evaluate.ts";
import { defaultExec } from "./llm/exec.ts";
import { PROVIDERS } from "./llm/providers.ts";
import { configPath, loadConfig } from "./model-config.ts";
import { MODEL_USAGE, parseModelArgs } from "./model-options.ts";
import { describeConfig, listModels, runModelSetup } from "./model-setup.ts";
import { parseCliArgs, UsageError, USAGE } from "./options.ts";
import { formatReport } from "./report.ts";
import { formatReview, runReview } from "./review/review.ts";
import { parseReviewArgs, REVIEW_USAGE } from "./review-options.ts";

/** Exit codes: 0 small change, 1 not a small change, 2 usage error or Bitbucket unreadable. */
async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "model") {
      return await model(rest);
    }
    if (first === "review") {
      return await review(rest);
    }
    const input = parseCliArgs(argv);
    if (input.kind === "help") {
      console.log(USAGE);
      return 0;
    }
    const bitbucket = createBitbucket({ token: process.env.BITBUCKET_TOKEN });
    const report = await evaluate(bitbucket, input.ref, input.options);
    console.log(formatReport(report));
    return report.eligible ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      const usage = first === "model" ? MODEL_USAGE : first === "review" ? REVIEW_USAGE : USAGE;
      console.error(`small-change: ${error.message}\n\n${usage}`);
    } else {
      console.error(`small-change: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 2;
  }
}

async function model(argv: string[]): Promise<number> {
  const command = parseModelArgs(argv);
  const out = (line = "") => console.log(line);
  switch (command.command) {
    case "help":
      console.log(MODEL_USAGE);
      return 0;
    case "show":
      console.log(await describeConfig(command.config ?? configPath()));
      return 0;
    case "list":
      await listModels({ exec: defaultExec }, command.provider, out);
      return 0;
    case "setup": {
      await runModelSetup(
        {
          exec: defaultExec,
          io: {
            input: process.stdin,
            output: process.stdout,
            interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          },
          configFile: command.config ?? configPath(),
          env: process.env,
        },
        command,
      );
      return 0;
    }
  }
}

async function review(argv: string[]): Promise<number> {
  const command = parseReviewArgs(argv);
  if (command.command === "help") {
    console.log(REVIEW_USAGE);
    return 0;
  }
  const file = command.config ?? configPath();
  const config = await loadConfig(file);
  if (config === undefined) {
    throw new Error(`No model is configured (${file}); run \`small-change model setup\` first`);
  }
  const result = await runReview(
    {
      bitbucket: createBitbucket({ token: process.env.BITBUCKET_TOKEN }),
      provider: PROVIDERS[config.provider],
      exec: defaultExec,
      config,
      env: process.env,
    },
    command.ref,
    command.options,
  );
  console.log(formatReview(result, command.options.post));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
