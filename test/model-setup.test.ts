import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Exec, ModelInfo, Provider, ProviderId, RunRequest } from "../src/llm/types.ts";
import { saveConfig } from "../src/model-config.ts";
import { describeConfig, runModelSetup, type SetupFlags } from "../src/model-setup.ts";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sc-setup-test-"));
  file = join(dir, "config.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NO_EXEC: Exec = async () => assert.fail("exec must not be called directly");

interface FakeProvider extends Provider {
  probes: RunRequest[];
}

function fake(id: ProviderId, options: { installed?: boolean; models?: ModelInfo[]; suggested?: ModelInfo[]; reject?: string } = {}): FakeProvider {
  const probes: RunRequest[] = [];
  return {
    id,
    label: `Fake ${id}`,
    binary: id,
    effortStyle: id === "cursor" ? "slug" : "flag",
    probes,
    isInstalled: async () => options.installed ?? true,
    listModels: async () => options.models,
    suggestedModels: options.suggested ?? [],
    async run(_exec, request) {
      probes.push(request);
      if (options.reject !== undefined) {
        throw new Error(options.reject);
      }
      return "OK";
    },
  };
}

function providers(overrides: Partial<Record<ProviderId, FakeProvider>> = {}) {
  return {
    claude: fake("claude", { suggested: [{ id: "default" }, { id: "opus" }, { id: "haiku" }] }),
    cursor: fake("cursor", { models: [{ id: "auto" }, { id: "grok-4.7-low" }, { id: "grok-4.7-medium" }, { id: "grok-4.7-high" }, { id: "grok-4.7-xhigh" }] }),
    codex: fake("codex", { models: [{ id: "gpt-6-astra", efforts: ["low", "medium", "high"] }, { id: "gpt-5.2", efforts: ["low", "medium", "high", "xhigh"] }] }),
    pi: fake("pi", { models: [{ id: "opencode-go/claude-haiku-5-5" }, { id: "cursorapi/composer-2.5", efforts: [] }], suggested: [{ id: "default" }] }),
    muse: fake("muse", { suggested: [{ id: "default" }, { id: "muse-spark-1.3" }] }),
    ...overrides,
  };
}

/** Runs the setup with `answers` as the typed lines; returns the output text. */
async function run(flags: Partial<SetupFlags>, answers: string[] | undefined, provs = providers()) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk));
  const config = await runModelSetup(
    {
      exec: NO_EXEC,
      io: { input: Readable.from(answers === undefined ? [] : answers.map((line) => `${line}\n`)), output, interactive: answers !== undefined },
      configFile: file,
      env: { PATH: "/bin", BITBUCKET_TOKEN: "secret" },
      providers: provs,
    },
    { yes: false, verify: true, ...flags },
  );
  return { config, text };
}

describe("model setup with flags", () => {
  it("claude: sets the effort from the budget, probes without Bitbucket variables, and saves", async () => {
    const provs = providers();
    const { config, text } = await run({ provider: "claude", model: "opus", budget: "large", yes: true }, undefined, provs);
    assert.deepEqual(config, { version: 1, provider: "claude", model: "opus", budget: "large", effort: "xhigh" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), config);
    assert.equal(provs.claude.probes.length, 1);
    assert.deepEqual(provs.claude.probes[0]?.env, { PATH: "/bin" });
    assert.equal(provs.claude.probes[0]?.effort, "xhigh");
    assert.match(text, /Saved /);
  });

  it("cursor: moves the effort in the slug and sets no separate effort", async () => {
    const { config } = await run({ provider: "cursor", model: "grok-4.7-low", budget: "unlimited", yes: true }, undefined);
    // max is above every detected variant, so the highest at or below it is used.
    assert.equal(config.model, "grok-4.7-xhigh");
    assert.equal(config.effort, undefined);
    assert.equal(config.budget, "unlimited");
  });

  it("cursor: lowers the slug for a smaller budget", async () => {
    const { config } = await run({ provider: "cursor", model: "grok-4.7-xhigh", budget: "small", yes: true }, undefined);
    assert.equal(config.model, "grok-4.7-medium");
  });

  it("cursor: accepts auto, which has no effort to move", async () => {
    const { config } = await run({ provider: "cursor", model: "auto", budget: "large", yes: true }, undefined);
    assert.equal(config.model, "auto");
  });

  it("codex: clamps the effort to what the model supports", async () => {
    const { config } = await run({ provider: "codex", model: "gpt-6-astra", budget: "unlimited", yes: true }, undefined);
    assert.equal(config.effort, "high");
    const again = await run({ provider: "codex", model: "gpt-5.2", budget: "large", yes: true }, undefined);
    assert.equal(again.config.effort, "xhigh");
  });

  it("pi: passes the budget as the effort, for any model that has reasoning levels", async () => {
    const { config } = await run({ provider: "pi", model: "opencode-go/claude-haiku-5-5", budget: "unlimited", yes: true }, undefined);
    assert.deepEqual(config, { version: 1, provider: "pi", model: "opencode-go/claude-haiku-5-5", budget: "unlimited", effort: "max" });
  });

  it("pi: sets no effort for a model without reasoning levels, and says so", async () => {
    const provs = providers();
    const { config, text } = await run({ provider: "pi", model: "cursorapi/composer-2.5", budget: "large", yes: true }, undefined, provs);
    assert.equal(config.effort, undefined);
    assert.equal(provs.pi.probes[0]?.effort, undefined);
    assert.match(text, /Effort    none: the model has no reasoning levels/);
  });

  it("muse: takes a model it cannot list, since the probe checks it", async () => {
    const provs = providers();
    const { config } = await run({ provider: "muse", model: "muse-spark-1.3", budget: "medium", yes: true }, undefined, provs);
    assert.deepEqual(config, { version: 1, provider: "muse", model: "muse-spark-1.3", budget: "medium", effort: "high" });
    assert.equal(provs.muse.probes.length, 1);
  });

  it("rejects a model the CLI does not list, saving nothing", async () => {
    await assert.rejects(run({ provider: "codex", model: "gpt-9", budget: "large", yes: true }, undefined), /does not list the model "gpt-9"/);
    await assert.rejects(stat(file), { code: "ENOENT" });
  });

  it("rejects an option-like model id", async () => {
    await assert.rejects(run({ provider: "claude", model: "--dangerously", budget: "large", yes: true }, undefined), /not a valid model id/);
  });

  it("does not save when the probe fails, and says to pick another model", async () => {
    const provs = providers({ codex: fake("codex", { models: [{ id: "gpt-5.5" }], reject: "model is not supported when using Codex with a ChatGPT account" }) });
    await assert.rejects(
      run({ provider: "codex", model: "gpt-5.5", budget: "large", yes: true }, undefined, provs),
      /did not accept gpt-5\.5: .*ChatGPT account\. Nothing was saved/,
    );
    await assert.rejects(stat(file), { code: "ENOENT" });
  });

  it("skips the probe with verify: false", async () => {
    const provs = providers();
    await run({ provider: "claude", model: "opus", budget: "small", yes: true, verify: false }, undefined, provs);
    assert.equal(provs.claude.probes.length, 0);
  });

  it("fails when the CLI is not installed", async () => {
    const provs = providers({ claude: fake("claude", { installed: false }) });
    await assert.rejects(run({ provider: "claude", model: "opus", budget: "large", yes: true }, undefined, provs), /`claude` was not found on PATH/);
  });

  it("without a terminal, takes whatever flags omit from the saved config, and fails if none", async () => {
    await assert.rejects(run({ provider: "claude", model: "opus", yes: true }, undefined), /pass --budget/);
    await saveConfig(file, { version: 1, provider: "claude", model: "haiku", budget: "medium", effort: "high" });
    const { config } = await run({ yes: true }, undefined);
    assert.deepEqual(config, { version: 1, provider: "claude", model: "haiku", budget: "medium", effort: "high" });
  });

  it("ignores an unreadable saved config and says so", async () => {
    await saveConfig(file, { version: 1, provider: "claude", model: "opus", budget: "large", effort: "xhigh" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{broken");
    const { text } = await run({ provider: "claude", model: "opus", budget: "large", yes: true }, undefined);
    assert.match(text, /Ignoring the current config/);
  });
});

describe("model setup interactively", () => {
  it("walks provider, model and budget by number, then confirms", async () => {
    // claude is the first installed provider; models: default, opus, haiku; budgets: unlimited, large, medium, small.
    const { config, text } = await run({}, ["1", "2", "4", "y"]);
    assert.deepEqual(config, { version: 1, provider: "claude", model: "opus", budget: "small", effort: "medium" });
    assert.match(text, /Provider \[1\]/);
    assert.match(text, /Save this\? \[Y\/n\]/);
  });

  it("offers only installed providers", async () => {
    const provs = providers({ claude: fake("claude", { installed: false, suggested: [{ id: "default" }] }) });
    // cursor is first now; pick its first model (auto), default budget (large), confirm.
    const { config, text } = await run({}, ["1", "1", "", ""], provs);
    assert.equal(config.provider, "cursor");
    assert.ok(!/1\. Fake claude/.test(text));
  });

  it("defaults to the saved choice on Enter", async () => {
    await saveConfig(file, { version: 1, provider: "claude", model: "opus", budget: "medium", effort: "high" });
    const { config } = await run({}, ["", "", "", ""]);
    assert.deepEqual(config, { version: 1, provider: "claude", model: "opus", budget: "medium", effort: "high" });
  });

  it("filters a long model list by text and takes a single match", async () => {
    const { config } = await run({}, ["2", "xhigh", "3", "y"]);
    // cursor, then "xhigh" matches only grok-4.7-xhigh; budget 3 = medium retargets it to grok-4.7-high.
    assert.equal(config.provider, "cursor");
    assert.equal(config.model, "grok-4.7-high");
  });

  it("takes a typed model name for a CLI that cannot list models", async () => {
    const { config } = await run({}, ["1", "my-custom-model", "2", "y"]);
    assert.equal(config.model, "my-custom-model");
  });

  it("saves nothing when the confirmation is declined", async () => {
    await assert.rejects(run({}, ["1", "2", "2", "n"]), /Not saved/);
    await assert.rejects(stat(file), { code: "ENOENT" });
  });

  it("fails clearly when the input ends early", async () => {
    await assert.rejects(run({}, ["1"]), /input ended/);
  });

  it("gives up after repeated invalid choices", async () => {
    await assert.rejects(run({}, ["9", "9", "9", "9", "9"]), /No valid choice for Provider/);
  });
});

describe("describeConfig", () => {
  it("points to the setup when nothing is saved", async () => {
    assert.match(await describeConfig(file), /No model is configured\. Run `small-change model setup`/);
  });

  it("describes the saved choice", async () => {
    await saveConfig(file, { version: 1, provider: "codex", model: "gpt-5.2", budget: "large", effort: "xhigh" });
    assert.match(await describeConfig(file), /codex \/ gpt-5\.2 \(budget large, effort xhigh\)/);
  });
});
