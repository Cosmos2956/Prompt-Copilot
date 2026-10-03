import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { chatgptDesktopController } from "./chatgptDesktopController";
import { SettingsPanel } from "./SettingsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { actionFeedback } from "./actionFeedback";
import { usePromptHistory } from "./promptHistory";
import {
  readPreferences,
  saveDefaultMode,
  saveAutomaticallySend,
} from "./preferences";
import { secretStore, MISSING_API_KEY_MESSAGE } from "./secretStore";
import {
  configuredPromptOptimizer,
  type OptimizationMode,
} from "./promptOptimizer";

type ActiveAction = "improve" | "run" | "improveAndRun" | null;
const modes: Array<{
  value: OptimizationMode;
  label: string;
  shortcut: string;
}> = [
  { value: "light", label: "Light", shortcut: "Ctrl+1" },
  { value: "smart", label: "Smart", shortcut: "Ctrl+2" },
  { value: "agent", label: "Agent", shortcut: "Ctrl+3" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [displayVersion, setDisplayVersion] = useState("");
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [improvedPrompt, setImprovedPrompt] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    prompt: string;
    message: string;
  } | null>(null);
  const copyBusy = useRef(false);
  const [preferences, setPreferences] = useState(readPreferences);
  const [mode, setMode] = useState<OptimizationMode>(preferences.defaultMode);
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<
    "improving" | "sending" | "sent" | "ready" | null
  >(null);
  const busy = useRef(false);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const [shortcutError, setShortcutError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = usePromptHistory();
  const [focusRequest, setFocusRequest] = useState(0);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(
    null,
  );
  const [configurationError, setConfigurationError] = useState("");
  const feedback = error ? actionFeedback(error) : null;

  useEffect(() => {
    let disposed = false;
    void getVersion()
      .then((version) => {
        const [major, minor] = version.split(".");
        if (!disposed) setDisplayVersion(`${major}.${minor.padStart(2, "0")}`);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  function resetPromptFields() {
    setOriginalPrompt("");
    setImprovedPrompt("");
    setCopyResult(null);
  }

  function clearPrompts() {
    if (busy.current || copyBusy.current) return;
    resetPromptFields();
    setError("");
    setPhase(null);
    originalInput.current?.focus({ preventScroll: true });
  }

  async function copyImprovedPrompt() {
    if (copyBusy.current || busy.current || !improvedPrompt.trim()) return;
    copyBusy.current = true;
    setCopying(true);
    setCopyResult(null);
    const prompt = improvedPrompt;
    try {
      await invoke("copy_prompt_to_clipboard", { prompt });
      setCopyResult({ prompt, message: "Copied" });
    } catch {
      setCopyResult({ prompt, message: "Could not copy. Try again." });
    } finally {
      copyBusy.current = false;
      setCopying(false);
    }
  }

  useEffect(() => {
    if (phase !== "sent" && phase !== "ready") return;
    const timeout = window.setTimeout(() => setPhase(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (focusRequest && !settingsOpen && !historyOpen) {
      // Wait until React has restored the textarea after leaving a secondary view.
      originalInput.current?.focus({ preventScroll: true });
    }
  }, [focusRequest, settingsOpen, historyOpen]);

  useEffect(() => {
    let disposed = false;
    const openRequestedSettings = async () => {
      if (disposed) return;
      try {
        const requested = await invoke<boolean>("take_settings_request");
        if (!disposed && requested) {
          setHistoryOpen(false);
          setSettingsOpen(true);
        }
      } catch {
        if (!disposed)
          setConfigurationError("Could not open Settings from the tray.");
      }
    };
    const listener = getCurrentWindow().listen("open-settings", () => {
      void openRequestedSettings();
    });
    void listener.then(openRequestedSettings).catch(() => {
      if (!disposed)
        setConfigurationError(
          "Could not prepare tray Settings. Restart Prompt Copilot.",
        );
    });
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void secretStore
      .isConfigured()
      .then((configured) => {
        if (!disposed) setApiKeyConfigured(configured);
      })
      .catch(() => {
        if (!disposed)
          setConfigurationError(
            "Could not read the saved API key. Check Settings.",
          );
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const listener = getCurrentWindow().listen<string | null>(
      "focus-original-prompt",
      (event) => {
        setSettingsOpen(false);
        setHistoryOpen(false);
        if (!busy.current && event.payload?.trim()) {
          setOriginalPrompt(event.payload);
          setImprovedPrompt("");
          setError("");
        }
        setFocusRequest((request) => request + 1);
      },
    );
    void listener.catch(() => {
      if (!disposed)
        setShortcutError(
          "Could not prepare shortcut focus. Restart Prompt Copilot.",
        );
    });
    void invoke<string | null>("shortcut_status")
      .then((message) => {
        if (!disposed) setShortcutError(message ?? "");
      })
      .catch(() => {
        if (!disposed)
          setShortcutError(
            "Could not check the global shortcut. Restart Prompt Copilot.",
          );
      });
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const runAction = async (action: Exclude<ActiveAction, null>) => {
    if (busy.current) return;
    const original = originalPrompt;
    const improved = improvedPrompt;
    const promptToRun = improved.trim() ? improved : original;
    if (action !== "run" && !original.trim()) return;
    if (action === "run" && !promptToRun.trim()) return;
    if ((action === "run" ? promptToRun : original).includes("\0")) {
      setPhase(null);
      setError("Remove null characters from the prompt before continuing.");
      return;
    }

    busy.current = true;
    setActiveAction(action);
    setPhase(action === "run" ? "sending" : "improving");
    setError("");
    try {
      if (action === "run") {
        await chatgptDesktopController.runPrompt(promptToRun);
        setPhase("sent");
      } else {
        const result = await configuredPromptOptimizer.optimize({
          originalPrompt: original,
          mode,
        });
        if (
          !result ||
          typeof result.improvedPrompt !== "string" ||
          !result.improvedPrompt.trim() ||
          result.improvedPrompt.includes("\0")
        ) {
          throw new Error(
            "The optimizer returned an invalid or empty prompt. Nothing was sent.",
          );
        }
        // Commit the exact result to the editor before native code hides the overlay.
        flushSync(() => setImprovedPrompt(result.improvedPrompt));
        history.add(original, result.improvedPrompt, mode);
        if (action === "improveAndRun" || preferences.automaticallySend) {
          flushSync(() => setPhase("sending"));
          await chatgptDesktopController.runPrompt(result.improvedPrompt);
          if (action === "improveAndRun") resetPromptFields();
          setPhase("sent");
        } else {
          setPhase("ready");
        }
      }
    } catch (cause) {
      setPhase(null);
      setError(errorMessage(cause));
      if (errorMessage(cause) === MISSING_API_KEY_MESSAGE)
        setApiKeyConfigured(false);
    } finally {
      busy.current = false;
      setActiveAction(null);
    }
  };

  useEffect(() => {
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (settingsOpen || historyOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setSettingsOpen(false);
          setHistoryOpen(false);
          setFocusRequest((request) => request + 1);
        }
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        const selectedMode = modes.find(
          (_, index) => event.key === String(index + 1),
        );
        if (selectedMode && !busy.current) {
          event.preventDefault();
          setMode(selectedMode.value);
          setError("");
        }
      }
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        void getCurrentWindow().hide();
      }
    };

    window.addEventListener("keydown", hideOnEscape);
    return () => window.removeEventListener("keydown", hideOnEscape);
  }, [settingsOpen, historyOpen]);

  const canImprove = Boolean(originalPrompt.trim()) && !activeAction;
  const canRun =
    Boolean(improvedPrompt.trim() || originalPrompt.trim()) && !activeAction;

  if (historyOpen) {
    return (
      <HistoryPanel
        entries={history.entries}
        error={history.error}
        onRestore={(entry) => {
          if (busy.current) return;
          setOriginalPrompt(entry.originalPrompt);
          setImprovedPrompt(entry.improvedPrompt);
          setMode(entry.optimizationMode);
          setError("");
          setHistoryOpen(false);
          setFocusRequest((request) => request + 1);
        }}
        onDelete={(id) => {
          if (!busy.current) history.remove(id);
        }}
        onClear={() => !busy.current && history.clear()}
        onBack={() => {
          setHistoryOpen(false);
          setFocusRequest((request) => request + 1);
        }}
      />
    );
  }

  if (settingsOpen) {
    return (
      <SettingsPanel
        preferences={preferences}
        onDefaultMode={(defaultMode) => {
          saveDefaultMode(defaultMode);
          setPreferences((current) => ({ ...current, defaultMode }));
          setMode(defaultMode);
        }}
        onAutomaticallySend={(automaticallySend) => {
          saveAutomaticallySend(automaticallySend);
          setPreferences((current) => ({ ...current, automaticallySend }));
        }}
        configured={apiKeyConfigured}
        onConfigured={setApiKeyConfigured}
        onBack={() => {
          setSettingsOpen(false);
          setFocusRequest((request) => request + 1);
          setConfigurationError("");
          setError("");
        }}
      />
    );
  }

  return (
    <main
      className="min-h-screen p-2 text-slate-100"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!event.repeat) {
            void runAction(event.shiftKey ? "improveAndRun" : "improve");
          }
        }
      }}
    >
      <div className="prompt-shell mx-auto flex min-h-[calc(100vh-1rem)] max-w-6xl flex-col rounded-[20px] border border-white/10 bg-[#0b0d12] p-4">
        <p
          data-tauri-drag-region
          className="mb-1 text-center text-xs text-slate-400"
        >
          {displayVersion ? `Version ${displayVersion}` : ""}
        </p>
        <header
          data-tauri-drag-region
          className="mb-3 flex flex-wrap items-center gap-2"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-400/10 text-lg font-semibold text-indigo-300">
            P
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Prompt Copilot
            </h1>
            <p className="text-xs text-slate-400">
              <kbd>Ctrl+Shift+Space</kbd> to open · Esc to hide
            </p>
          </div>
          <div
            className="ml-auto flex items-center gap-1 rounded-xl border border-white/10 bg-[#151820] p-1"
            aria-label="Optimization mode"
            role="group"
          >
            {modes.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                disabled={Boolean(activeAction)}
                aria-keyshortcuts={option.shortcut.replace("Ctrl", "Control")}
                title={`${option.label} mode (${option.shortcut})`}
                onClick={() => {
                  setMode(option.value);
                  setError("");
                }}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  mode === option.value
                    ? "bg-indigo-400 text-[#0b0d12]"
                    : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Open Settings"
            title="Settings"
            disabled={Boolean(activeAction)}
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100 disabled:opacity-40"
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path
                d="m9 3-.6 2.2-1.8 1L4.4 6 2.9 8.6l1.6 1.6v2.1l-1.6 1.6 1.5 2.6 2.2-.3 1.8 1L9 19.5h3l.6-2.3 1.8-1 2.2.3 1.5-2.6-1.6-1.6v-2.1l1.6-1.6L16.6 6l-2.2.2-1.8-1L12 3Z"
                transform="translate(1.5 1)"
              />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </header>

        <div className="prompt-editors grid flex-1 gap-3 sm:grid-cols-2">
          <section className="flex min-w-0 flex-col rounded-xl border border-white/10 bg-[#151820] p-3">
            <label
              htmlFor="original-prompt"
              className="mb-2 text-sm font-medium text-slate-200"
            >
              Original Prompt
            </label>
            <textarea
              id="original-prompt"
              readOnly={Boolean(activeAction)}
              ref={originalInput}
              autoFocus
              value={originalPrompt}
              onChange={(event) => {
                setOriginalPrompt(event.target.value);
                setPhase(null);
                setError("");
              }}
              placeholder="Write your rough prompt here…"
              className="min-h-36 w-full flex-1 resize-none rounded-lg border border-white/10 bg-[#0e1118] p-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/15"
            />
          </section>

          <section className="flex min-w-0 flex-col rounded-xl border border-white/10 bg-[#151820] p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="improved-prompt"
                className="text-sm font-medium text-slate-200"
              >
                Improved Prompt
              </label>
              <div className="flex items-center gap-2">
                <span
                  role="status"
                  aria-live="polite"
                  className="text-xs text-slate-400"
                >
                  {copyResult?.prompt === improvedPrompt
                    ? copyResult.message
                    : "Text to send"}
                </span>
                <button
                  type="button"
                  onClick={() => void copyImprovedPrompt()}
                  disabled={
                    !improvedPrompt.trim() || Boolean(activeAction) || copying
                  }
                  className="rounded-md border border-white/10 px-2 py-1 text-xs text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copying ? "Copying…" : "Copy"}
                </button>
              </div>
            </div>
            <textarea
              id="improved-prompt"
              readOnly={Boolean(activeAction)}
              value={improvedPrompt}
              onChange={(event) => {
                setImprovedPrompt(event.target.value);
                setPhase(null);
                setError("");
              }}
              placeholder="The improved prompt appears here. Edit it before sending."
              className="min-h-36 w-full flex-1 resize-none rounded-lg border border-white/10 bg-[#0e1118] p-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/15"
            />
          </section>
        </div>

        <footer className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <p>
              {preferences.automaticallySend
                ? "Improve also sends automatically · enabled in Settings"
                : "Improve creates a rewrite for review."}
            </p>
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-indigo-200"
            >
              {phase === "improving"
                ? "Improving…"
                : phase === "sending"
                  ? "Sending to ChatGPT…"
                  : phase === "sent"
                    ? "Sent"
                    : phase === "ready"
                      ? "Ready to review"
                      : ""}
            </p>
          </div>
          {feedback && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-sm text-rose-200"
            >
              <p className="min-w-0 flex-1">{feedback.text}</p>
              {feedback.settings && (
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2"
                  onClick={() => setSettingsOpen(true)}
                >
                  Open Settings
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss error"
                className="shrink-0 rounded px-1 text-xs text-slate-400 hover:text-slate-100"
                onClick={() => setError("")}
              >
                Dismiss
              </button>
            </div>
          )}
          {configurationError && (
            <p role="alert" className="text-xs text-amber-200">
              {configurationError}{" "}
              <button
                type="button"
                className="underline"
                disabled={Boolean(activeAction)}
                onClick={() => setSettingsOpen(true)}
              >
                Open Settings
              </button>
            </p>
          )}
          {shortcutError && (
            <p role="alert" className="text-xs text-amber-200">
              Global shortcut unavailable. Close other Prompt Copilot instances
              and restart.
            </p>
          )}
          {history.error && (
            <p role="status" className="text-xs text-amber-200">
              {history.error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={Boolean(activeAction)}
                onClick={() => setHistoryOpen(true)}
                className="rounded-lg px-2 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-100 disabled:opacity-40"
              >
                History
              </button>
              <button
                type="button"
                onClick={clearPrompts}
                title="Clear both prompt boxes"
                disabled={
                  Boolean(activeAction) ||
                  copying ||
                  (!originalPrompt && !improvedPrompt)
                }
                className="rounded-lg px-2 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Run sends:{" "}
              {improvedPrompt.trim() ? "Improved Prompt" : "Original Prompt"}
            </p>
          </div>
          <div className="action-grid grid gap-2">
            <button
              type="button"
              onClick={() => void runAction("improve")}
              title="Improve (Ctrl+Enter)"
              aria-keyshortcuts="Control+Enter"
              disabled={!canImprove}
              className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-medium text-slate-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="block">Improve</span>
              <kbd className="mt-0.5 block text-[11px] font-normal text-slate-400">
                Ctrl+Enter
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => void runAction("run")}
              disabled={!canRun}
              className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-medium text-slate-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="block">Run in ChatGPT</span>
              <span className="mt-0.5 block text-[11px] font-normal text-slate-400">
                Send current text
              </span>
            </button>
            <button
              type="button"
              onClick={() => void runAction("improveAndRun")}
              title="Improve & Run (Ctrl+Shift+Enter)"
              aria-keyshortcuts="Control+Shift+Enter"
              disabled={!canImprove}
              className="primary-action rounded-xl bg-indigo-400 px-4 py-2.5 text-sm font-semibold text-[#0b0d12] hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="block">Improve &amp; Run</span>
              <kbd className="mt-0.5 block text-[11px] font-normal">
                Ctrl+Shift+Enter
              </kbd>
            </button>
          </div>
        </footer>
      </div>
    </main>
  );
}

export default App;
