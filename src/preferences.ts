import type { OptimizationMode } from "./promptOptimizer";

export type Preferences = {
  defaultMode: OptimizationMode;
  automaticallySend: boolean;
};

// Reuse the previous mode preference as the initial default; session mode changes
// no longer overwrite an explicitly selected startup default.
const MODE_KEY = "prompt-copilot.optimization-mode";
const SEND_KEY = "prompt-copilot.automatically-send";

export function readPreferences(): Preferences {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return {
      defaultMode: mode === "light" || mode === "agent" ? mode : "smart",
      automaticallySend: localStorage.getItem(SEND_KEY) === "true",
    };
  } catch {
    return { defaultMode: "smart", automaticallySend: false };
  }
}

export function saveDefaultMode(mode: OptimizationMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function saveAutomaticallySend(enabled: boolean): void {
  localStorage.setItem(SEND_KEY, String(enabled));
}
