const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load, storage, runtime, button, nodes } = require("./helpers.cjs");
const KEY = "prompt-copilot.history";

function history(store) {
  const hooks = runtime();
  const { usePromptHistory } = load(
    "src/promptHistory.ts",
    { react: hooks.react },
    { storage: store },
  );
  return () => hooks.render(usePromptHistory);
}

test("history retains exactly the newest 50 rewrites across reload and only expected fields", () => {
  const store = storage();
  const render = history(store);
  for (let i = 0; i < 53; i++)
    render().add(`original ${i}\n  🌍`, `improved ${i}`, "agent");
  const entries = history(store)().entries;
  assert.equal(entries.length, 50);
  assert.equal(entries[0].originalPrompt, "original 52\n  🌍");
  assert.equal(entries[49].improvedPrompt, "improved 3");
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 50);
  assert.deepEqual(Object.keys(entries[0]).sort(), [
    "createdAt",
    "id",
    "improvedPrompt",
    "optimizationMode",
    "originalPrompt",
  ]);
});

test("delete persists and Clear All removes only the history key", () => {
  const store = storage({ preference: "keep" });
  const render = history(store);
  render().add("one", "rewrite one", "light");
  render().add("two", "rewrite two", "smart");
  assert.equal(render().remove(render().entries[0].id), true);
  assert.equal(history(store)().entries[0].originalPrompt, "one");
  assert.equal(render().clear(), true);
  assert.equal(store.getItem(KEY), null);
  assert.equal(store.getItem("preference"), "keep");
});

test("malformed history resets explicitly; invalid entries and extra fields are rejected on load", () => {
  const broken = storage({ [KEY]: "not json" });
  const render = history(broken);
  assert.match(render().error, /Could not read/);
  render().clear();
  assert.deepEqual(render().entries, []);
  assert.equal(render().error, "");
  const valid = {
    id: "one",
    originalPrompt: "raw",
    improvedPrompt: "rewrite",
    optimizationMode: "smart",
    createdAt: "2026-10-02T00:00:00.000Z",
  };
  const store = storage({
    [KEY]: JSON.stringify([
      { ...valid, providerMetadata: "discard" },
      valid,
      { ...valid, id: "two", improvedPrompt: "bad\0" },
      { ...valid, id: "three", optimizationMode: "invalid" },
    ]),
  });
  assert.deepEqual(history(store)().entries, [valid]);
});

test("quota failure keeps existing history and does not throw into the send pipeline", () => {
  const store = storage();
  const render = history(store);
  render().add("existing", "rewrite", "light");
  const saved = store.getItem(KEY);
  store.setItem = () => {
    throw Error("quota");
  };
  assert.doesNotThrow(() => render().add("new", "new rewrite", "smart"));
  assert.equal(render().entries.length, 1);
  assert.equal(store.getItem(KEY), saved);
  assert.match(render().error, /Could not save/);
});

test("history restoration calls only restore; Clear All requires confirmation and supports cancel", () => {
  const hooks = runtime();
  const { HistoryPanel } = load("src/HistoryPanel.tsx", { react: hooks.react });
  const entry = {
    id: "1",
    originalPrompt: "Preview",
    improvedPrompt: "rewrite",
    optimizationMode: "smart",
    createdAt: "2026-10-02T00:00:00Z",
  };
  const restored = [],
    deleted = [];
  let cleared = 0;
  const props = {
    entries: [entry],
    error: "",
    onRestore: (item) => restored.push(item),
    onDelete: (id) => deleted.push(id),
    onClear: () => {
      cleared++;
      return true;
    },
    onBack() {},
  };
  const render = () => hooks.render(() => HistoryPanel(props));
  button(render(), "Preview").props.onClick();
  assert.deepEqual(restored, [entry]);
  button(render(), "Delete").props.onClick();
  assert.deepEqual(deleted, ["1"]);
  button(render(), "Clear All").props.onClick();
  assert.equal(cleared, 0);
  assert.ok(nodes(render()).some((node) => node.props?.role === "alertdialog"));
  button(render(), "Cancel").props.onClick();
  assert.equal(cleared, 0);
  button(render(), "Clear All").props.onClick();
  button(render(), "Confirm Clear All").props.onClick();
  assert.equal(cleared, 1);
});
