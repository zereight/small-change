import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { claude, parseClaudeOutput } from "../src/llm/claude.ts";
import { codex, codexError, parseCodexModels } from "../src/llm/codex.ts";
import { cursor, parseCursorModels, parseCursorOutput } from "../src/llm/cursor.ts";
import { agentEnv, defaultExec } from "../src/llm/exec.ts";
import type { Exec, RunRequest } from "../src/llm/types.ts";

const REQUEST: RunRequest = {
  prompt: "Review this",
  model: "opus",
  effort: "xhigh",
  workdir: "/tmp/empty",
  env: { PATH: "/bin" },
  timeoutMs: 1000,
};

/** An Exec that records the call and answers with `reply`. */
function recording(reply: (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>) {
  const calls: { file: string; args: readonly string[]; options: Parameters<Exec>[2] }[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return reply(args);
  };
  return { exec, calls };
}

describe("claude", () => {
  it("reads the result event of the array form", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
      { type: "result", subtype: "success", is_error: false, result: "OK" },
    ]);
    assert.deepEqual(parseClaudeOutput(stdout), { ok: true, text: "OK" });
  });

  it("reads the single-object form", () => {
    assert.deepEqual(parseClaudeOutput('{"type":"result","result":"fine"}'), { ok: true, text: "fine" });
  });

  it("reports an error result with its message", () => {
    const out = parseClaudeOutput('[{"type":"result","is_error":true,"result":"Credit balance too low"}]');
    assert.deepEqual(out, { ok: false, error: "Credit balance too low" });
  });

  it("fails on output that is not JSON or has no result", () => {
    assert.deepEqual(parseClaudeOutput("oops"), { ok: false });
    assert.deepEqual(parseClaudeOutput('[{"type":"system"}]'), { ok: false });
  });

  it("runs with no tools, no session and no settings, and takes the prompt on stdin", async () => {
    const { exec, calls } = recording(async () => ({
      code: 0,
      stdout: '[{"type":"result","is_error":false,"result":"answer"}]',
      stderr: "",
    }));
    assert.equal(await claude.run(exec, REQUEST), "answer");
    const [call] = calls;
    assert.equal(call?.file, "claude");
    assert.deepEqual(call?.args, [
      "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
      "--setting-sources", "", "--model", "opus", "--effort", "xhigh",
    ]);
    assert.equal(call?.options?.input, "Review this");
    assert.equal(call?.options?.cwd, "/tmp/empty");
    assert.deepEqual(call?.options?.env, { PATH: "/bin" });
  });

  it("omits --model for the default and --effort when there is none", async () => {
    const { exec, calls } = recording(async () => ({ code: 0, stdout: '{"type":"result","result":"x"}', stderr: "" }));
    await claude.run(exec, { ...REQUEST, model: "default", effort: undefined });
    assert.ok(!calls[0]?.args.includes("--model"));
    assert.ok(!calls[0]?.args.includes("--effort"));
  });

  it("throws with the CLI's own message when the result is an error", async () => {
    const { exec } = recording(async () => ({
      code: 1,
      stdout: '[{"type":"result","is_error":true,"result":"Not logged in"}]',
      stderr: "",
    }));
    await assert.rejects(claude.run(exec, REQUEST), /claude failed: Not logged in/);
  });

  it("throws with stderr when there is no JSON", async () => {
    const { exec } = recording(async () => ({ code: 3, stdout: "", stderr: "line1\nboom" }));
    await assert.rejects(claude.run(exec, REQUEST), /exited with 3: line1\nboom/);
  });

  it("cannot list models and suggests aliases", async () => {
    assert.equal(await claude.listModels(async () => assert.fail("must not run")), undefined);
    assert.ok(claude.suggestedModels.some((model) => model.id === "default"));
  });
});

describe("cursor", () => {
  const LIST = [
    "\u001b[2K\u001b[GLoading models…",
    "Available models",
    "",
    "auto - Auto (current, default)",
    "gpt-5.3-codex-low - Codex 5.3 Low",
    "claude-opus-5-thinking-high - Opus 5\u200b Thinking High",
    "",
    "Tip: use --model <id> to switch",
  ].join("\n");

  it("parses the list: one slug - label per line, ignoring headers and tips", () => {
    assert.deepEqual(parseCursorModels(LIST), [
      { id: "auto", label: "Auto (current, default)" },
      { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low" },
      { id: "claude-opus-5-thinking-high", label: "Opus 5 Thinking High" },
    ]);
  });

  it("reads the single result object", () => {
    assert.deepEqual(parseCursorOutput('{"type":"result","subtype":"success","is_error":false,"result":"OK"}'), { ok: true, text: "OK" });
    assert.deepEqual(parseCursorOutput('{"type":"result","is_error":true,"result":"bad"}'), { ok: false, error: "bad" });
    assert.deepEqual(parseCursorOutput("not json"), { ok: false });
    assert.deepEqual(parseCursorOutput('{"type":"other"}'), { ok: false });
  });

  it("runs read-only, sandboxed, in the given workspace, with the prompt on stdin", async () => {
    const { exec, calls } = recording(async () => ({ code: 0, stdout: '{"type":"result","result":"answer"}', stderr: "" }));
    assert.equal(await cursor.run(exec, { ...REQUEST, model: "grok-4.7-xhigh" }), "answer");
    assert.deepEqual(calls[0]?.args, [
      "-p", "--mode", "ask", "--trust", "--sandbox", "enabled", "--output-format", "json",
      "--workspace", "/tmp/empty", "--model", "grok-4.7-xhigh",
    ]);
    assert.equal(calls[0]?.options?.input, "Review this");
  });

  it("lists models through --list-models and surfaces a failure", async () => {
    const ok = recording(async () => ({ code: 0, stdout: LIST, stderr: "" }));
    assert.equal((await cursor.listModels(ok.exec))?.length, 3);
    assert.deepEqual(ok.calls[0]?.args, ["--list-models"]);
    const bad = recording(async () => ({ code: 1, stdout: "", stderr: "Not logged in" }));
    await assert.rejects(cursor.listModels(bad.exec), /Not logged in/);
  });
});

describe("codex", () => {
  const CATALOG = JSON.stringify({
    models: [
      { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
      { slug: "gpt-daybreak", visibility: "hide" },
      { slug: "gpt-5.2", visibility: "list", supported_reasoning_levels: ["low", "medium"] },
      { display_name: "no slug" },
    ],
  });

  it("parses the catalog, dropping hidden and slugless entries and unknown efforts", () => {
    assert.deepEqual(parseCodexModels(CATALOG), [
      { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "high"] },
      { id: "gpt-5.2", efforts: ["low", "medium"] },
    ]);
  });

  it("pulls the API's message out of the error line", () => {
    const stderr = [
      "warning: something",
      'ERROR: {"type":"error","status":400,"error":{"message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
    ].join("\n");
    assert.match(codexError(stderr), /^The 'gpt-5\.5' model is not supported/);
    assert.equal(codexError("a\nb\nc"), "a\nb\nc");
    assert.equal(codexError("ERROR: plain text"), "plain text");
  });

  it("runs read-only and ephemeral, sets the effort, and reads the answer file", async () => {
    let answerFile = "";
    const { exec, calls } = recording(async (args) => {
      answerFile = args[args.indexOf("--output-last-message") + 1] as string;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(answerFile, "the answer\n");
      return { code: 0, stdout: "", stderr: "" };
    });
    assert.equal(await codex.run(exec, { ...REQUEST, model: "gpt-5.2", effort: "high" }), "the answer");
    const args = calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 6), ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C"]);
    assert.ok(args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.2");
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(args.at(-1), "-");
    assert.equal(calls[0]?.options?.input, "Review this");
    assert.notEqual(answerFile.indexOf("/tmp/empty"), 0, "the answer file is outside the agent's workdir");
    await assert.rejects(readFile(answerFile), { code: "ENOENT" });
  });

  it("fails with the API's message when codex exits non-zero", async () => {
    const { exec } = recording(async () => ({
      code: 1,
      stdout: "",
      stderr: 'ERROR: {"error":{"message":"model_not_found for this account"}}',
    }));
    await assert.rejects(codex.run(exec, REQUEST), /codex failed: model_not_found for this account/);
  });
});

describe("agent execution", () => {
  it("removes every BITBUCKET_ variable from the agent's environment", () => {
    const env = agentEnv({ PATH: "/bin", HOME: "/h", BITBUCKET_TOKEN: "secret", BITBUCKET_API_TOKEN: "s2", BITBUCKET_USERNAME: "u" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  });

  it("runs a program, feeds stdin and captures output and the exit code", async () => {
    const result = await defaultExec(process.execPath, ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('err'); process.exitCode = 3"], { input: "hello" });
    assert.deepEqual(result, { code: 3, stdout: "hello", stderr: "err" });
  });

  it("rejects when the program is missing", async () => {
    await assert.rejects(defaultExec("definitely-not-a-program-xyz", []), /was not found on PATH/);
  });

  it("kills a program that runs past the timeout", async () => {
    await assert.rejects(defaultExec(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 }), /did not finish within 200 ms/);
  });
});
