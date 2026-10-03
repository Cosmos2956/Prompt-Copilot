const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers.cjs");
const config = load("src/providers/geminiConfig.ts");
const request = { originalPrompt: "Rewrite this instruction", mode: "smart" };
const response = (text, finishReason = "STOP") => ({
  candidates: [
    {
      finishReason,
      content: {
        parts: [{ thought: true, text: "ignore this reasoning" }, { text }],
      },
    },
  ],
});
function provider(invoke) {
  const { GeminiPromptOptimizer } = load(
    "src/providers/geminiPromptOptimizer.ts",
    { "@tauri-apps/api/core": { invoke }, "./geminiConfig": config },
  );
  return new GeminiPromptOptimizer();
}

test("active Gemini uses native transport, chosen mode, prompt-only schema, and ignores thought parts", async () => {
  const calls = [];
  const optimizer = provider(async (...args) => {
    calls.push(args);
    return response(
      JSON.stringify({
        improvedPrompt: "Exact rewrite",
        changes: ["not returned"],
      }),
    );
  });
  assert.deepEqual(await optimizer.optimize({ ...request, mode: "agent" }), {
    improvedPrompt: "Exact rewrite",
  });
  assert.equal(calls[0][0], "gemini_request");
  assert.equal(calls[0][1].model, config.DEFAULT_GEMINI_MODEL);
  assert.deepEqual(Object.keys(calls[0][1]), ["model", "body"]);
  assert.match(
    calls[0][1].body.systemInstruction.parts[0].text,
    /Selected mode: AGENT/,
  );
  assert.deepEqual(
    Object.keys(calls[0][1].body.generationConfig.responseSchema.properties),
    ["improvedPrompt"],
  );
});

test("Gemini truncation retries once with the same prompt-only schema and can recover", async () => {
  const calls = [];
  const optimizer = provider(async (_, args) => {
    calls.push(args);
    return calls.length === 1
      ? response("partial", "MAX_TOKENS")
      : response('{"improvedPrompt":"Complete rewrite"}');
  });
  assert.equal(
    (await optimizer.optimize(request)).improvedPrompt,
    "Complete rewrite",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].body.generationConfig,
    calls[1].body.generationConfig,
  );
  assert.match(
    calls[1].body.systemInstruction.parts[0].text,
    /previous rewrite was cut off/,
  );
});

test("second Gemini truncation fails closed; network error is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      return response("partial", "MAX_TOKENS");
    }).optimize(request),
    /length limit/,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    provider(async () => {
      calls++;
      throw Error("secret-bearing diagnostic");
    }).optimize(request),
    /could not be completed/,
  );
  assert.equal(calls, 1);
});

test("Gemini safety, incomplete, malformed, blank and NUL results are rejected", async () => {
  const invalid = [
    { promptFeedback: { blockReason: "SAFETY" } },
    response("{}", "SAFETY"),
    response("{}", "OTHER"),
    response("not JSON"),
    response("{}"),
    response('{"improvedPrompt":"  "}'),
    response(JSON.stringify({ improvedPrompt: "bad\0text" })),
  ];
  for (const value of invalid)
    await assert.rejects(provider(async () => value).optimize(request));
  let calls = 0;
  const optimizer = provider(async () => {
    calls++;
  });
  await assert.rejects(
    optimizer.optimize({ ...request, originalPrompt: "bad\0text" }),
  );
  await assert.rejects(optimizer.optimize({ ...request, mode: "unknown" }));
  assert.equal(calls, 0);
});
