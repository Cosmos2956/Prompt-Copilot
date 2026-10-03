const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function load(file, dependencies, storage) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "localStorage", compiled)(
    (name) => (name in dependencies ? dependencies[name] : require(name)),
    module,
    module.exports,
    storage,
  );
  return module.exports;
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("preferences default safely and persist independently", () => {
  const store = storage();
  const prefs = load("src/preferences.ts", {}, store);
  assert.deepEqual(prefs.readPreferences(), {
    defaultMode: "smart",
    automaticallySend: false,
  });
  prefs.saveDefaultMode("agent");
  prefs.saveAutomaticallySend(true);
  assert.deepEqual(load("src/preferences.ts", {}, store).readPreferences(), {
    defaultMode: "agent",
    automaticallySend: true,
  });
  prefs.saveAutomaticallySend(false);
  assert.equal(prefs.readPreferences().defaultMode, "agent");
  assert.equal(prefs.readPreferences().automaticallySend, false);
  const malformed = load(
    "src/preferences.ts",
    {},
    storage({
      "prompt-copilot.optimization-mode": "invalid",
      "prompt-copilot.automatically-send": "yes",
    }),
  );
  assert.deepEqual(malformed.readPreferences(), {
    defaultMode: "smart",
    automaticallySend: false,
  });
  const unavailable = load(
    "src/preferences.ts",
    {},
    {
      getItem() {
        throw Error("denied");
      },
    },
  );
  assert.equal(unavailable.readPreferences().automaticallySend, false);
});

function find(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function appHarness(automaticallySend, optimize) {
  const hooks = [];
  let cursor = 0;
  const sent = [];
  const preferences = load(
    "src/preferences.ts",
    {},
    storage({ "prompt-copilot.automatically-send": String(automaticallySend) }),
  );
  const App = load("src/App.tsx", {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks))
          hooks[index] = typeof initial === "function" ? initial() : initial;
        return [
          hooks[index],
          (value) => {
            hooks[index] =
              typeof value === "function" ? value(hooks[index]) : value;
          },
        ];
      },
      useRef(initial) {
        const index = cursor++;
        return (hooks[index] ??= { current: initial });
      },
      useEffect() {},
    },
    "@tauri-apps/api/core": {},
    "@tauri-apps/api/window": {},
    "@tauri-apps/api/app": {},
    "./SettingsPanel": { SettingsPanel() {} },
    "./actionFeedback": load("src/actionFeedback.ts", {
      "./secretStore": { MISSING_API_KEY_MESSAGE: "Missing key" },
    }),
    "./HistoryPanel": { HistoryPanel() {} },
    "./promptHistory": {
      usePromptHistory: () => ({ entries: [], error: "", add() {} }),
    },
    "./secretStore": {
      secretStore: {},
      MISSING_API_KEY_MESSAGE: "Missing key",
    },
    "./preferences": preferences,
    "./promptOptimizer": { configuredPromptOptimizer: { optimize } },
    "./chatgptDesktopController": {
      chatgptDesktopController: {
        runPrompt: async (prompt) => sent.push(prompt),
      },
    },
  }).default;
  const render = () => {
    cursor = 0;
    return App();
  };
  find(render(), (node) => node.props?.id === "original-prompt").props.onChange(
    { target: { value: "rough prompt" } },
  );
  return {
    sent,
    render,
    press(shift = false) {
      render().props.onKeyDown({
        key: "Enter",
        ctrlKey: true,
        shiftKey: shift,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      });
    },
  };
}

for (const [enabled, explicit, expected] of [
  [false, false, 0],
  [true, false, 1],
  [false, true, 1],
  [true, true, 1],
]) {
  test(`sending: automatic=${enabled}, explicit=${explicit}`, async () => {
    let calls = 0;
    const app = appHarness(enabled, async () => {
      calls++;
      return { improvedPrompt: "Exact improved text" };
    });
    app.press(explicit);
    app.press(explicit); // A repeated trigger during the request must not send twice.
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.deepEqual(app.sent, expected ? ["Exact improved text"] : []);
    assert.equal(
      find(app.render(), (node) => node.props?.id === "improved-prompt").props
        .value,
      explicit ? "" : "Exact improved text",
    );
  });
}

test("automatic sending stops on provider failure or invalid output", async () => {
  for (const optimize of [
    async () => {
      throw Error("offline");
    },
    async () => ({ improvedPrompt: "" }),
    async () => ({ improvedPrompt: "bad\0text" }),
  ]) {
    const app = appHarness(true, optimize);
    app.press();
    await new Promise(setImmediate);
    assert.deepEqual(app.sent, []);
  }
});
