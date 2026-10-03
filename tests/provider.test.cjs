const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

global.window = globalThis;
const source = fs.readFileSync(
  "src/providers/openaiPromptOptimizer.ts",
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

function optimizer(invoke) {
  const module = { exports: {} };
  new Function("require", "exports", "module", compiled)(
    (name) => {
      assert.equal(name, "@tauri-apps/api/core");
      return { invoke };
    },
    module.exports,
    module,
  );
  return new module.exports.OpenAIPromptOptimizer();
}

const request = { originalPrompt: "Draft a plan", mode: "smart" };
const response = (text) => ({
  status: 200,
  data: {
    output: [
      {
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              improvedPrompt: text,
              detectedTask: "Planning",
              changes: [],
            }),
          },
        ],
      },
    ],
  },
});

test("every optimization uses native transport, with no key passed by the frontend", async () => {
  const calls = [];
  let result = "First result";
  const provider = optimizer(async (command, args) => {
    calls.push({ command, args });
    return response(result);
  });
  assert.equal(
    (await provider.optimize(request)).improvedPrompt,
    "First result",
  );
  result = "Next result";
  assert.equal(
    (await provider.optimize({ ...request, mode: "agent" })).improvedPrompt,
    "Next result",
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "openai_request");
    assert.deepEqual(Object.keys(call.args), ["body"]);
    assert.equal(call.args.body.model, "gpt-5");
    assert.equal(call.args.body.store, false);
    assert.ok(!/authorization|apiKey/i.test(JSON.stringify(call.args)));
  }
  assert.match(
    calls[1].args.body.input[0].content[0].text,
    /Selected mode: AGENT/,
  );
});

test("missing key and credential read failures are clear and never retried", async () => {
  for (const message of [
    "Add your API key in Settings before using prompt optimization.",
    "Windows Credential Manager could not read your API key. Try again or check Settings.",
  ]) {
    let calls = 0;
    const provider = optimizer(async () => {
      calls++;
      throw message;
    });
    await assert.rejects(
      provider.optimize(request),
      (error) => error.message === message,
    );
    assert.equal(calls, 1);
  }
});

test("authentication errors are sanitized and never retried", async () => {
  let calls = 0;
  const provider = optimizer(async () => {
    calls++;
    return { status: 401, data: null };
  });
  await assert.rejects(
    provider.optimize(request),
    /Check or replace it in Settings/,
  );
  assert.equal(calls, 1);
});

test("network failures retry once; invalid structured output is rejected", async () => {
  let calls = 0;
  const provider = optimizer(async () => {
    calls++;
    throw "Could not connect to OpenAI. Check your connection and try again.";
  });
  await assert.rejects(provider.optimize(request), /Check your connection/);
  assert.equal(calls, 2);
  const malformed = optimizer(async () => ({
    status: 200,
    data: {
      output: [{ content: [{ type: "output_text", text: "not json" }] }],
    },
  }));
  await assert.rejects(
    malformed.optimize(request),
    /invalid optimization result/,
  );
});
