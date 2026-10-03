import { useState } from "react";
import type { HistoryEntry } from "./promptHistory";

type Props = {
  entries: HistoryEntry[];
  error: string;
  onRestore: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => boolean;
  onBack: () => void;
};
const buttonStyle =
  "rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40";

export function HistoryPanel({
  entries,
  error,
  onRestore,
  onDelete,
  onClear,
  onBack,
}: Props) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <main className="h-screen p-2 text-slate-100">
      <section
        aria-labelledby="history-title"
        className="flex h-full flex-col rounded-[24px] border border-white/10 bg-[#0b0d12] p-5"
      >
        <header
          data-tauri-drag-region
          className="mb-3 flex shrink-0 items-center justify-between gap-3"
        >
          <div>
            <h1 id="history-title" className="text-lg font-semibold">
              History
            </h1>
            <p className="text-xs text-slate-400">
              Last 50 successful rewrites · saved on this device
            </p>
          </div>
          <button
            autoFocus
            type="button"
            className={buttonStyle}
            onClick={onBack}
          >
            Back
          </button>
        </header>
        {error && (
          <p role="alert" className="mb-3 text-sm text-amber-300">
            {error}
          </p>
        )}
        {confirmClear ? (
          <div
            role="alertdialog"
            aria-label="Clear prompt history"
            aria-describedby="clear-history-description"
            className="mb-3 rounded-xl border border-white/15 p-3"
          >
            <p id="clear-history-description" className="text-sm">
              Delete all saved history? Your current prompt will stay open.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonStyle}
                onClick={() => {
                  if (onClear()) setConfirmClear(false);
                }}
              >
                Confirm Clear All
              </button>
              <button
                type="button"
                className={buttonStyle}
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              className={buttonStyle}
              disabled={!entries.length && !error}
              onClick={() => setConfirmClear(true)}
            >
              Clear All
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!entries.length && (
            <p className="py-6 text-sm text-slate-400">
              No saved rewrites yet.
            </p>
          )}
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#151820] p-2"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg p-2 text-left hover:bg-white/5"
                  onClick={() => onRestore(entry)}
                >
                  <span className="block truncate text-sm">
                    {entry.originalPrompt
                      .split(/\r?\n/)
                      .find((line) => line.trim())
                      ?.slice(0, 160) ?? "Saved prompt"}
                  </span>
                  <span className="mt-1 block text-xs text-slate-400">
                    <span className="capitalize">{entry.optimizationMode}</span>{" "}
                    ·{" "}
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </span>
                </button>
                <button
                  type="button"
                  className={buttonStyle}
                  aria-label={`Delete rewrite from ${new Date(entry.createdAt).toLocaleString()}`}
                  onClick={() => onDelete(entry.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Select a rewrite to restore it for review. Nothing is sent
          automatically.
        </p>
      </section>
    </main>
  );
}
