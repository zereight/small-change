#!/usr/bin/env node
import { createBitbucket } from "./bitbucket.ts";
import { evaluate } from "./evaluate.ts";
import { parseCliArgs, UsageError, USAGE } from "./options.ts";
import { formatReport } from "./report.ts";

/** Exit codes: 0 small change, 1 not a small change, 2 usage error or Bitbucket unreadable. */
async function main(): Promise<number> {
  try {
    const input = parseCliArgs(process.argv.slice(2));
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
      console.error(`small-change: ${error.message}\n\n${USAGE}`);
    } else {
      console.error(`small-change: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 2;
  }
}

process.exitCode = await main();
