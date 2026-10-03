const fs = require("node:fs");
const ts = require("typescript");

exports.load = (file, dependencies = {}, environment = {}) => {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "localStorage",
    "window",
    "crypto",
    compiled,
  )(
    (name) => (name in dependencies ? dependencies[name] : require(name)),
    module,
    module.exports,
    environment.storage,
    environment.window,
    require("node:crypto").webcrypto,
  );
  return module.exports;
};

exports.storage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

exports.runtime = () => {
  const hooks = [];
  let cursor = 0;
  let pending = [];
  const react = {
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
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (
        !previous ||
        !deps ||
        deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
      ) {
        pending.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: callback() };
        });
      }
    },
  };
  return {
    react,
    render(callback, commit = () => {}) {
      cursor = 0;
      const value = callback();
      commit(value);
      const effects = pending;
      pending = [];
      effects.forEach((effect) => effect());
      return value;
    },
    dispose() {
      hooks.forEach((hook) => hook?.cleanup?.());
    },
  };
};

exports.nodes = function nodes(value) {
  if (!value || typeof value !== "object") return [];
  return [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
};
exports.text = function text(value) {
  if (value === null || value === undefined || typeof value === "boolean")
    return "";
  if (typeof value !== "object") return String(value);
  return [value.props?.children].flat(Infinity).map(text).join("");
};
exports.button = (tree, label) =>
  exports
    .nodes(tree)
    .find(
      (node) => node.type === "button" && exports.text(node).startsWith(label),
    );
exports.flush = () => new Promise(setImmediate);
exports.deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
