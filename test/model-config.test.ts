import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError, configPath, isModelId, loadConfig, saveConfig } from "../src/model-config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sc-config-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("honors XDG_CONFIG_HOME, else uses ~/.config", () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/small-change/config.json");
    assert.equal(configPath({ HOME: "/home/u" }), "/home/u/.config/small-change/config.json");
  });
});

describe("config file", () => {
  it("round-trips and leaves no temporary file", async () => {
    const path = join(dir, "nested", "config.json");
    await saveConfig(path, { version: 1, provider: "codex", model: "gpt-5.2", budget: "large", effort: "high" });
    assert.deepEqual(await loadConfig(path), { version: 1, provider: "codex", model: "gpt-5.2", budget: "large", effort: "high" });
    assert.deepEqual(await readdir(join(dir, "nested")), ["config.json"]);
  });

  it("overwrites the whole file", async () => {
    const path = join(dir, "config.json");
    await saveConfig(path, { version: 1, provider: "codex", model: "a", budget: "small", effort: "medium" });
    await saveConfig(path, { version: 1, provider: "cursor", model: "b-high", budget: "medium" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, provider: "cursor", model: "b-high", budget: "medium" });
  });

  it("round-trips a verifier, and a config without one stays without one", async () => {
    const path = join(dir, "config.json");
    const config = {
      version: 1 as const,
      provider: "claude" as const,
      model: "opus",
      budget: "large" as const,
      effort: "xhigh" as const,
      verifier: { provider: "muse" as const, model: "muse-spark-1.3", budget: "medium" as const, effort: "high" as const },
    };
    await saveConfig(path, config);
    assert.deepEqual(await loadConfig(path), config);
    await writeFile(path, '{"version":1,"provider":"claude","model":"opus","budget":"large"}');
    assert.equal((await loadConfig(path))?.verifier, undefined);
  });

  it("is undefined when missing", async () => {
    assert.equal(await loadConfig(join(dir, "none.json")), undefined);
  });

  it("names the file and the fix when it cannot be used", async () => {
    const path = join(dir, "bad.json");
    const cases: [string, RegExp][] = [
      ["{oops", /not valid JSON/],
      ["[]", /unknown provider|version/],
      ['{"version":2}', /unsupported version/],
      ['{"version":1,"provider":"toString","model":"m","budget":"large"}', /unknown provider/],
      ['{"version":1,"provider":"claude","model":"--evil","budget":"large"}', /invalid model/],
      ['{"version":1,"provider":"claude","model":"opus","budget":"huge"}', /unknown budget/],
      ['{"version":1,"provider":"claude","model":"opus","budget":"large","effort":"warp"}', /unknown effort/],
      ['{"version":1,"provider":"claude","model":"opus","budget":"large","verifier":{"provider":"toString","model":"m","budget":"large"}}', /verifier: unknown provider/],
      ['{"version":1,"provider":"claude","model":"opus","budget":"large","verifier":{"provider":"muse","model":"--evil","budget":"large"}}', /verifier: invalid model/],
      ['{"version":1,"provider":"claude","model":"opus","budget":"large","verifier":"muse"}', /verifier: expected a JSON object/],
    ];
    for (const [text, message] of cases) {
      await writeFile(path, text);
      await assert.rejects(loadConfig(path), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, message);
        assert.ok(error.message.includes(path));
        assert.match(error.message, /model setup/);
        return true;
      });
    }
  });
});

describe("isModelId", () => {
  it("accepts slugs and bracketed forms, rejects option-like or spaced ids", () => {
    for (const ok of ["opus", "gpt-5.6-sol-high", "claude-opus-4-8[effort=high]", "org/model:v1"]) {
      assert.equal(isModelId(ok), true, ok);
    }
    for (const bad of ["", "-m", "--model", "a b", "a;b", "a\nb", "$(x)"]) {
      assert.equal(isModelId(bad), false, JSON.stringify(bad));
    }
  });
});
