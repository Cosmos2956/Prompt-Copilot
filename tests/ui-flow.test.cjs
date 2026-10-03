const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  load,
  storage,
  runtime,
  nodes,
  text,
  button,
  flush,
  deferred,
} = require("./helpers.cjs");

function browser() {
  const events = new Map(),
    timers = new Map();
  let next = 0;
  return {
    events,
    timers,
    window: {
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: (name) => events.delete(name),
      setTimeout: (callback, delay) => {
        const id = ++next;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  };
}

test("startup UI defaults from native state, prevents duplicate changes, and accepts tray events", async () => {
  const hooks = runtime(),
    env = browser(),
    listeners = new Map(),
    pending = deferred(),
    calls = [];
  const { StartupSetting } = load(
    "src/StartupSetting.tsx",
    {
      react: hooks.react,
      "@tauri-apps/api/window": {
        getCurrentWindow: () => ({
          listen: async (name, callback) => {
            listeners.set(name, callback);
            return () => listeners.delete(name);
          },
        }),
      },
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return command === "startup_status"
            ? { enabled: false, error: null }
            : pending.promise;
        },
      },
    },
    { window: env.window },
  );
  const render = () => hooks.render(StartupSetting);
  const checkbox = () => nodes(render()).find((node) => node.type === "input");
  assert.equal(checkbox().props.disabled, true);
  await flush();
  assert.equal(checkbox().props.checked, false);
  checkbox().props.onChange({ target: { checked: true } });
  checkbox().props.onChange({ target: { checked: true } });
  assert.equal(
    calls.filter((call) => call.command === "set_startup_enabled").length,
    1,
  );
  listeners.get("startup-changed")({ payload: { enabled: true, error: null } });
  assert.equal(checkbox().props.checked, true);
  // A stale command response must not overwrite a newer tray event.
  pending.resolve({ enabled: false, error: null });
  await flush();
  assert.equal(checkbox().props.checked, true);
  hooks.dispose();
  await flush();
  assert.equal(listeners.size, 0);
});

test("startup read failure shows an actionable error and leaves toggle disabled", async () => {
  const hooks = runtime(),
    env = browser();
  const { StartupSetting } = load(
    "src/StartupSetting.tsx",
    {
      react: hooks.react,
      "@tauri-apps/api/window": {
        getCurrentWindow: () => ({ listen: async () => () => {} }),
      },
      "@tauri-apps/api/core": {
        invoke: async () => {
          throw Error("raw registry diagnostic");
        },
      },
    },
    { window: env.window },
  );
  const render = () => hooks.render(StartupSetting);
  render();
  await flush();
  assert.match(text(render()), /Could not read/);
  assert.doesNotMatch(text(render()), /raw registry/);
  assert.equal(
    nodes(render()).find((node) => node.type === "input").props.disabled,
    true,
  );
  hooks.dispose();
});

test("Settings trims and clears a synthetic key, blocks duplicate save, and confirms removal", async () => {
  const hooks = runtime(),
    pending = deferred();
  let configured = false,
    saves = [],
    removed = 0;
  const { SettingsPanel } = load("src/SettingsPanel.tsx", {
    react: hooks.react,
    "./secretStore": {
      secretStore: {
        isConfigured: async () => false,
        save: async (key) => {
          saves.push(key);
          return pending.promise;
        },
        remove: async () => {
          removed++;
        },
      },
    },
    "./providers/geminiConfig": { GEMINI_MODEL_LABEL: "Test model" },
    "./StartupSetting": { StartupSetting() {} },
  });
  const onConfigured = (value) => {
    configured = value;
  };
  const render = () =>
    hooks.render(() =>
      SettingsPanel({
        configured,
        onConfigured,
        onBack() {},
        preferences: { defaultMode: "smart", automaticallySend: false },
        onDefaultMode() {},
        onAutomaticallySend() {},
      }),
    );
  render();
  await flush();
  nodes(render())
    .find((node) => node.type === "input")
    .props.onChange({ target: { value: "  synthetic-key  " } });
  const submit = () =>
    nodes(render())
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} });
  submit();
  submit();
  assert.deepEqual(saves, ["synthetic-key"]);
  pending.resolve();
  await flush();
  assert.equal(configured, true);
  button(render(), "Replace Key").props.onClick();
  assert.equal(
    nodes(render()).find((node) => node.type === "input").props.value,
    "",
  );
  button(render(), "Cancel").props.onClick();
  button(render(), "Remove API Key").props.onClick();
  assert.equal(removed, 0);
  button(render(), "Cancel").props.onClick();
  assert.equal(removed, 0);
  button(render(), "Remove API Key").props.onClick();
  button(render(), "Confirm removal").props.onClick();
  await flush();
  assert.equal(removed, 1);
  assert.equal(configured, false);
  hooks.dispose();
});

function app(options = {}) {
  const hooks = runtime(),
    env = browser(),
    listeners = new Map(),
    sent = [],
    copied = [],
    rewrites = [];
  let focusCount = 0,
    optimizationCalls = 0;
  let settingsRequested = false;
  function SettingsPanel() {}
  function HistoryPanel() {}
  const { default: App } = load(
    "src/App.tsx",
    {
      react: hooks.react,
      "react-dom": { flushSync: (callback) => callback() },
      "./SettingsPanel": { SettingsPanel },
      "./HistoryPanel": { HistoryPanel },
      "./actionFeedback": load("src/actionFeedback.ts", {
        "./secretStore": { MISSING_API_KEY_MESSAGE: "Missing key" },
      }),
      "./preferences": {
        readPreferences: () => ({
          defaultMode: "smart",
          automaticallySend: options.auto ?? false,
        }),
        saveDefaultMode() {},
        saveAutomaticallySend() {},
      },
      "./secretStore": {
        secretStore: { isConfigured: async () => true },
        MISSING_API_KEY_MESSAGE: "Missing key",
      },
      "./promptHistory": {
        usePromptHistory: () => ({
          entries: [],
          error: "",
          add: (...args) => rewrites.push(args),
          remove() {},
          clear: () => true,
        }),
      },
      "./promptOptimizer": {
        configuredPromptOptimizer: {
          optimize: async () => {
            optimizationCalls++;
            return options.optimize
              ? options.optimize()
              : { improvedPrompt: "Exact rewrite" };
          },
        },
      },
      "./chatgptDesktopController": {
        chatgptDesktopController: {
          runPrompt: async (prompt) => {
            sent.push(prompt);
            if (options.send) await options.send();
          },
        },
      },
      "@tauri-apps/api/app": { getVersion: async () => "1.0.0" },
      "@tauri-apps/api/window": {
        getCurrentWindow: () => ({
          listen: async (name, callback) => {
            listeners.set(name, callback);
            return () => listeners.delete(name);
          },
          hide: async () => {},
        }),
      },
      "@tauri-apps/api/core": {
        invoke: async (name, args) => {
          if (name === "copy_prompt_to_clipboard") {
            copied.push(args.prompt);
            if (options.copy) await options.copy();
            return;
          }
          if (name === "shortcut_status") return null;
          const requested = settingsRequested;
          settingsRequested = false;
          return requested;
        },
      },
    },
    { window: env.window },
  );
  const render = () =>
    hooks.render(App, (tree) => {
      const input = nodes(tree).find(
        (node) => node.props?.id === "original-prompt",
      );
      if (input) input.props.ref.current = { focus: () => focusCount++ };
    });
  const edit = (value) =>
    nodes(render())
      .find((node) => node.props?.id === "original-prompt")
      .props.onChange({ target: { value } });
  const press = (shift = false, extras = {}) =>
    render().props.onKeyDown({
      key: "Enter",
      ctrlKey: true,
      shiftKey: shift,
      nativeEvent: { isComposing: false },
      preventDefault() {},
      ...extras,
    });
  edit("rough prompt");
  return {
    render,
    edit,
    press,
    sent,
    copied,
    rewrites,
    env,
    listeners,
    SettingsPanel,
    HistoryPanel,
    count: () => optimizationCalls,
    focus: () => focusCount,
    dispose: hooks.dispose,
    requestSettings: () => {
      settingsRequested = true;
    },
  };
}

test("combined action transitions through improving/sending and clears Sent feedback", async () => {
  const optimize = deferred(),
    send = deferred();
  const ui = app({
    optimize: () => optimize.promise,
    send: () => send.promise,
  });
  ui.press(true);
  ui.press(true);
  assert.match(text(ui.render()), /Improving…/);
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "original-prompt")
      .props.readOnly,
    true,
  );
  optimize.resolve({ improvedPrompt: "Exact returned prompt" });
  await flush();
  assert.match(text(ui.render()), /Version 1\.00/);
  assert.match(text(ui.render()), /Sending to ChatGPT…/);
  assert.deepEqual(ui.sent, ["Exact returned prompt"]);
  assert.equal(ui.count(), 1);
  assert.equal(button(ui.render(), "Clear").props.disabled, true);
  button(ui.render(), "Clear").props.onClick();
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "original-prompt")
      .props.value,
    "rough prompt",
  );
  send.resolve();
  await flush();
  for (const id of ["original-prompt", "improved-prompt"]) {
    assert.equal(
      nodes(ui.render()).find((node) => node.props?.id === id).props.value,
      "",
    );
  }
  assert.deepEqual(ui.rewrites, [
    ["rough prompt", "Exact returned prompt", "smart"],
  ]);
  assert.match(text(ui.render()), /Sent/);
  const timer = [...ui.env.timers.values()].find(
    (timer) => timer.delay === 3500,
  );
  assert.ok(timer);
  timer.callback();
  assert.doesNotMatch(text(ui.render()), /Sent/);
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "original-prompt")
      .props.readOnly,
    false,
  );
  ui.dispose();
});

test("Clear empties both editors and copy feedback without sending or deleting history", async () => {
  const ui = app();
  ui.press();
  await flush();
  button(ui.render(), "Copy").props.onClick();
  await flush();
  assert.match(text(ui.render()), /Copied/);
  const focusBefore = ui.focus();
  button(ui.render(), "Clear").props.onClick();
  for (const id of ["original-prompt", "improved-prompt"]) {
    assert.equal(
      nodes(ui.render()).find((node) => node.props?.id === id).props.value,
      "",
    );
  }
  assert.doesNotMatch(text(ui.render()), /Copied|Ready to review/);
  assert.equal(button(ui.render(), "Clear").props.disabled, true);
  assert.equal(ui.focus(), focusBefore + 1);
  assert.equal(ui.rewrites.length, 1);
  assert.equal(ui.sent.length, 0);
  ui.dispose();
});

test("send failure preserves the successful rewrite and history; never retries", async () => {
  const ui = app({
    send: async () => {
      throw Error("keyboard input interrupted");
    },
  });
  ui.press(true);
  await flush();
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.rewrites.length, 1);
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "improved-prompt")
      .props.value,
    "Exact rewrite",
  );
  assert.match(text(ui.render()), /Check ChatGPT before retrying/);
  ui.dispose();
});

test("invalid input, held repeat, and IME events never begin optimization", () => {
  const ui = app();
  ui.press(true, { repeat: true });
  ui.press(true, { nativeEvent: { isComposing: true } });
  ui.edit("bad\0prompt");
  ui.press(true);
  assert.equal(ui.count(), 0);
  assert.deepEqual(ui.sent, []);
  ui.dispose();
});

test("History restore does not send with automatic sending on; capture preserves empty fallback and Unicode", async () => {
  const ui = app({ auto: true });
  await flush();
  button(ui.render(), "History").props.onClick();
  const history = ui.render();
  assert.equal(history.type, ui.HistoryPanel);
  history.props.onRestore({
    originalPrompt: "saved",
    improvedPrompt: "saved rewrite",
    optimizationMode: "agent",
  });
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "improved-prompt")
      .props.value,
    "saved rewrite",
  );
  assert.equal(ui.count(), 0);
  assert.deepEqual(ui.sent, []);
  ui.listeners.get("focus-original-prompt")({ payload: "   " });
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "original-prompt")
      .props.value,
    "saved",
  );
  button(ui.render(), "History").props.onClick();
  ui.render();
  ui.listeners.get("focus-original-prompt")({
    payload: "हैलो 🌍\n  code\n\tline",
  });
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "original-prompt")
      .props.value,
    "हैलो 🌍\n  code\n\tline",
  );
  assert.equal(
    nodes(ui.render()).find((node) => node.props?.id === "improved-prompt")
      .props.value,
    "",
  );
  assert.ok(ui.focus() > 0);
  assert.deepEqual(ui.sent, []);
  ui.dispose();
});

test("tray Settings request navigates the existing overlay through its listener", async () => {
  // Startup navigation through the frontend event is covered without clicking the Windows tray.
  const ui = app();
  await flush();
  assert.ok(ui.listeners.has("open-settings"));
  ui.listeners.get("open-settings")();
  await flush();
  // A consumed/absent request must not navigate spuriously.
  assert.equal(ui.render().type, "main");
  ui.requestSettings();
  ui.listeners.get("open-settings")();
  await flush();
  assert.equal(ui.render().type, ui.SettingsPanel);
  ui.dispose();
});

test("feedback hides raw diagnostics and preserves guidance for partial send", () => {
  const { actionFeedback } = load("src/actionFeedback.ts", {
    "./secretStore": { MISSING_API_KEY_MESSAGE: "Missing key" },
  });
  assert.equal(actionFeedback("Missing key").settings, true);
  assert.match(
    actionFeedback("Keyboard input was interrupted.").text,
    /Check ChatGPT/,
  );
  assert.equal(
    actionFeedback("Could not focus ChatGPT: 0x123456").settings,
    false,
  );
  assert.doesNotMatch(
    actionFeedback("unknown diagnostic synthetic-secret").text,
    /synthetic-secret|diagnostic/,
  );
});

test("composer feedback distinguishes discovery, readable text, and focus failures", () => {
  const { actionFeedback } = load("src/actionFeedback.ts", {
    "./secretStore": { MISSING_API_KEY_MESSAGE: "Missing key" },
  });
  assert.match(
    actionFeedback("No visible ChatGPT message box was recognized.").text,
    /Could not identify/,
  );
  assert.match(
    actionFeedback(
      "ChatGPT does not expose readable message text, so automatic submission was stopped.",
    ).text,
    /could not be read/,
  );
  assert.match(
    actionFeedback("Could not read the ChatGPT message box: 0x123").text,
    /could not be read/,
  );
  assert.match(
    actionFeedback("The ChatGPT message box did not receive keyboard focus.")
      .text,
    /did not keep focus/,
  );
  assert.match(
    actionFeedback("ChatGPT message box lost focus; no keys were sent.").text,
    /did not keep focus/,
  );
  assert.match(
    actionFeedback(
      "ChatGPT message box is no longer available. Submission stopped.",
    ).text,
    /became unavailable/,
  );
});

test("draft feedback distinguishes an existing draft from a change after paste", () => {
  const { actionFeedback } = load("src/actionFeedback.ts", {
    "./secretStore": { MISSING_API_KEY_MESSAGE: "Missing key" },
  });
  assert.match(
    actionFeedback("ChatGPT already has an unsent draft. Nothing was pasted.")
      .text,
    /Nothing was pasted/,
  );
  assert.match(
    actionFeedback(
      "The ChatGPT draft changed after paste. It was not submitted; check the draft.",
    ).text,
    /changed before submission/,
  );
});

test("Copy uses the exact edited improved prompt without sending or optimizing", async () => {
  const ui = app();
  assert.equal(button(ui.render(), "Copy").props.disabled, true);
  const prompt = "  Edited rewrite 🌟\r\nsecond line  ";
  nodes(ui.render())
    .find((node) => node.props?.id === "improved-prompt")
    .props.onChange({ target: { value: prompt } });
  button(ui.render(), "Copy").props.onClick();
  await flush();
  assert.deepEqual(ui.copied, [prompt]);
  assert.match(text(ui.render()), /Copied/);
  assert.equal(ui.sent.length, 0);
  assert.equal(ui.count(), 0);
  nodes(ui.render())
    .find((node) => node.props?.id === "improved-prompt")
    .props.onChange({ target: { value: "new edit" } });
  assert.doesNotMatch(text(ui.render()), /Copied/);
  ui.dispose();
});

test("Copy handles failure, duplicate clicks and edits during an in-flight copy", async () => {
  const copying = deferred();
  const ui = app({ copy: () => copying.promise });
  const edit = (value) =>
    nodes(ui.render())
      .find((node) => node.props?.id === "improved-prompt")
      .props.onChange({ target: { value } });
  edit("old rewrite");
  const click = button(ui.render(), "Copy").props.onClick;
  click();
  click();
  assert.equal(ui.copied.length, 1);
  assert.equal(button(ui.render(), "Copying…").props.disabled, true);
  edit("new rewrite");
  copying.reject(new Error("private native diagnostic"));
  await flush();
  assert.doesNotMatch(
    text(ui.render()),
    /Copied|private native diagnostic|Could not copy/,
  );
  button(ui.render(), "Copy").props.onClick();
  await flush();
  assert.match(text(ui.render()), /Could not copy. Try again./);
  assert.equal(ui.sent.length, 0);
  ui.dispose();
});
