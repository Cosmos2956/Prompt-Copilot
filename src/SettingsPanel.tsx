import { useEffect, useRef, useState } from "react";
import { secretStore } from "./secretStore";
import { GEMINI_MODEL_LABEL } from "./providers/geminiConfig";
import { StartupSetting } from "./StartupSetting";
import type { Preferences } from "./preferences";
import type { OptimizationMode } from "./promptOptimizer";

type Props = {
  preferences: Preferences;
  onDefaultMode: (mode: OptimizationMode) => void;
  onAutomaticallySend: (enabled: boolean) => void;
  configured: boolean | null;
  onConfigured: (configured: boolean) => void;
  onBack: () => void;
};

const buttonStyle =
  "rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-40";

export function SettingsPanel({
  configured,
  onConfigured,
  onBack,
  preferences,
  onDefaultMode,
  onAutomaticallySend,
}: Props) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    let disposed = false;
    void secretStore
      .isConfigured()
      .then((value) => {
        if (!disposed) onConfigured(value);
      })
      .catch(() => {
        if (!disposed)
          setError(
            "Could not read Windows Credential Manager. Try reopening Settings.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [onConfigured]);

  const save = async () => {
    if (busy.current) return;
    const trimmed = key.trim();
    if (!trimmed) {
      setError("Enter an API key before saving.");
      return;
    }
    busy.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await secretStore.save(trimmed);
      setKey("");
      setEditing(false);
      onConfigured(true);
      setMessage("API key saved securely.");
    } catch {
      // Do not render arbitrary IPC error objects near secret input.
      setError(
        "Could not save the API key. Check the key and try again. Your previous key is unchanged.",
      );
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  const remove = async () => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await secretStore.remove();
      setKey("");
      setEditing(false);
      setConfirmRemove(false);
      onConfigured(false);
      setMessage("API key removed.");
    } catch {
      setError("Could not remove the saved API key. Try again.");
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  return (
    <main className="min-h-screen p-2 text-slate-100">
      <section
        aria-labelledby="settings-title"
        className="flex h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-[24px] border border-white/10 bg-[#0b0d12] p-5"
      >
        <header
          data-tauri-drag-region
          className="mb-3 flex shrink-0 items-center justify-between"
        >
          <h1 id="settings-title" className="text-lg font-semibold">
            Settings
          </h1>
          <button
            autoFocus
            type="button"
            className={buttonStyle}
            onClick={onBack}
          >
            Back
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
          <section aria-labelledby="ai-title">
            <h2
              id="ai-title"
              className="text-xs uppercase tracking-wider text-slate-400"
            >
              AI
            </h2>
            <p className="mt-1 text-sm">
              Google Gemini{" "}
              <span className="text-slate-400">· {GEMINI_MODEL_LABEL}</span>
            </p>
            <div className="mt-2 rounded-xl border border-white/10 bg-[#151820] p-3">
              <h2 className="text-sm font-medium">Gemini API Key</h2>
              <p role="status" className="mt-2 text-sm text-slate-300">
                {configured === null
                  ? "Checking saved key…"
                  : configured
                    ? "✓ Configured"
                    : "No API key configured"}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Stored in Windows Credential Manager for your Windows account.
              </p>
              {(configured === false || editing) && !confirmRemove && (
                <form
                  className="mt-4 flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <label htmlFor="api-key" className="sr-only">
                    New Gemini API key
                  </label>
                  <input
                    id="api-key"
                    type="password"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={2560}
                    disabled={working}
                    placeholder="Enter API key"
                    className="min-w-32 flex-1 rounded-xl border border-white/15 bg-[#0e1118] px-3 py-2 text-sm outline-none focus:border-indigo-400"
                  />
                  <button
                    type="submit"
                    disabled={working}
                    className={buttonStyle}
                  >
                    {working ? "Saving…" : "Save"}
                  </button>
                  {configured && (
                    <button
                      type="button"
                      disabled={working}
                      className={buttonStyle}
                      onClick={() => {
                        setKey("");
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </form>
              )}
              {configured && !editing && !confirmRemove && (
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    disabled={working}
                    className={buttonStyle}
                    onClick={() => {
                      setEditing(true);
                      setMessage("");
                      setError("");
                    }}
                  >
                    Replace Key
                  </button>
                  <button
                    type="button"
                    disabled={working}
                    className={buttonStyle}
                    onClick={() => {
                      setConfirmRemove(true);
                      setMessage("");
                      setError("");
                    }}
                  >
                    Remove API Key
                  </button>
                </div>
              )}
              {confirmRemove && (
                <div
                  className="mt-4"
                  role="alertdialog"
                  aria-label="Confirm API key removal"
                >
                  <p className="text-sm">
                    Remove the saved key? Optimization will be unavailable until
                    you add another key.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={working}
                      className={buttonStyle}
                      onClick={() => void remove()}
                    >
                      {working ? "Removing…" : "Confirm removal"}
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      className={buttonStyle}
                      onClick={() => setConfirmRemove(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {message && (
              <p role="status" className="mt-4 text-sm text-emerald-300">
                {message}
              </p>
            )}
            <p className="mt-auto pt-5 text-xs text-slate-500">
              Your saved key is used automatically. Saving does not test
              authentication.
            </p>
          </section>
          <section
            aria-labelledby="optimization-title"
            className="border-t border-white/10 pt-3"
          >
            <h2
              id="optimization-title"
              className="mb-2 text-xs uppercase tracking-wider text-slate-400"
            >
              Optimization
            </h2>
            <label className="flex items-center justify-between gap-3 text-sm">
              Default mode
              <select
                value={preferences.defaultMode}
                onChange={(event) => {
                  try {
                    onDefaultMode(event.target.value as OptimizationMode);
                    setError("");
                  } catch {
                    setError(
                      "Could not save the default mode. Your setting is unchanged.",
                    );
                  }
                }}
                className="rounded-lg border border-white/15 bg-[#151820] px-3 py-1.5"
              >
                <option value="light">Light</option>
                <option value="smart">Smart</option>
                <option value="agent">Agent</option>
              </select>
            </label>
            <p className="mt-1 text-xs text-slate-400">
              Used now and when the app starts. Main-window mode changes apply
              to this session.
            </p>
          </section>
          <section
            aria-labelledby="modes-title"
            className="border-t border-white/10 pt-3"
          >
            <h2
              id="modes-title"
              className="mb-2 text-xs uppercase tracking-wider text-slate-400"
            >
              Modes explained
            </h2>
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="font-medium text-slate-200">Light</dt>
                <dd className="mt-0.5 text-slate-400">
                  Cleans up wording and improves clarity.
                  <br />
                  Keeps your phrasing with minimal expansion.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-200">Smart</dt>
                <dd className="mt-0.5 text-slate-400">
                  Clarifies the goal and expected output.
                  <br />
                  Structures the prompt and makes useful constraints clear.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-200">Agent</dt>
                <dd className="mt-0.5 text-slate-400">
                  Prepares the prompt for an autonomous agent.
                  <br />
                  Includes completion checks and stopping conditions where
                  useful.
                </dd>
              </div>
            </dl>
          </section>
          <section
            aria-labelledby="keyboard-title"
            className="border-t border-white/10 pt-3"
          >
            <h2
              id="keyboard-title"
              className="mb-2 text-xs uppercase tracking-wider text-slate-400"
            >
              Keyboard
            </h2>
            <dl className="grid grid-cols-2 gap-1 text-xs">
              <dt>Ctrl+Shift+Space</dt>
              <dd>Open Prompt Copilot</dd>
              <dt>Ctrl+Enter</dt>
              <dd>Improve</dd>
              <dt>Ctrl+Shift+Enter</dt>
              <dd>Improve &amp; Run</dd>
            </dl>
          </section>
          <StartupSetting />
          <section
            aria-labelledby="behavior-title"
            className="border-t border-white/10 pt-3"
          >
            <h2
              id="behavior-title"
              className="mb-2 text-xs uppercase tracking-wider text-slate-400"
            >
              Behavior
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={preferences.automaticallySend}
                onChange={(event) => {
                  try {
                    onAutomaticallySend(event.target.checked);
                    setError("");
                  } catch {
                    setError(
                      "Could not save automatic sending. Your setting is unchanged.",
                    );
                  }
                }}
              />
              Automatically send after optimization
            </label>
            <p className="mt-1 text-xs text-slate-400">
              When enabled, Improve and Ctrl+Enter also send the improved prompt
              to ChatGPT. Improve &amp; Run always sends.
            </p>
          </section>
        </div>
        {error && (
          <p role="alert" className="mt-2 shrink-0 text-sm text-rose-300">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
