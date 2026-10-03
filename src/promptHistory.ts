import { useRef, useState } from "react";
import type { OptimizationMode } from "./promptOptimizer";

export type HistoryEntry = {
  id: string;
  originalPrompt: string;
  improvedPrompt: string;
  optimizationMode: OptimizationMode;
  createdAt: string;
};

const STORAGE_KEY = "prompt-copilot.history";
const LIMIT = 50;

function readHistory(): { entries: HistoryEntry[]; error: string } {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(saved)) throw new Error("Invalid history");
    const entries: HistoryEntry[] = [];
    for (const item of saved) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.originalPrompt !== "string" ||
        !item.originalPrompt.trim() ||
        typeof item.improvedPrompt !== "string" ||
        !item.improvedPrompt.trim() ||
        item.originalPrompt.includes("\0") ||
        item.improvedPrompt.includes("\0") ||
        !["light", "smart", "agent"].includes(item.optimizationMode) ||
        typeof item.createdAt !== "string" ||
        !Number.isFinite(Date.parse(item.createdAt))
      )
        continue;
      if (entries.some((entry) => entry.id === item.id)) continue;
      // Project only the stored prompt fields; never retain provider metadata.
      entries.push({
        id: item.id,
        originalPrompt: item.originalPrompt,
        improvedPrompt: item.improvedPrompt,
        optimizationMode: item.optimizationMode,
        createdAt: item.createdAt,
      });
      if (entries.length === LIMIT) break;
    }
    return { entries, error: "" };
  } catch {
    return {
      entries: [],
      error: "Could not read local history. Clear All can reset it.",
    };
  }
}

export function usePromptHistory() {
  const [state, setState] = useState(readHistory);
  const current = useRef(state);
  const commit = (entries: HistoryEntry[], clear = false) => {
    try {
      if (clear) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      current.current = { entries, error: "" };
      setState(current.current);
      return true;
    } catch {
      setState({
        ...current.current,
        error:
          "Could not save local history. Your current prompt is still available.",
      });
      return false;
    }
  };
  return {
    ...state,
    add(
      originalPrompt: string,
      improvedPrompt: string,
      optimizationMode: OptimizationMode,
    ) {
      // A storage failure must not interrupt an explicitly requested send.
      try {
        const entry = {
          id: crypto.randomUUID(),
          originalPrompt,
          improvedPrompt,
          optimizationMode,
          createdAt: new Date().toISOString(),
        };
        commit([entry, ...current.current.entries].slice(0, LIMIT));
      } catch {
        setState({
          ...current.current,
          error: "Could not save this rewrite to local history.",
        });
      }
    },
    remove(id: string) {
      return commit(current.current.entries.filter((entry) => entry.id !== id));
    },
    clear() {
      return commit([], true);
    },
  };
}
