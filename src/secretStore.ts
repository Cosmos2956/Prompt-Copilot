import { invoke } from "@tauri-apps/api/core";

export const MISSING_API_KEY_MESSAGE =
  "Add your Gemini API key in Settings before using prompt optimization.";

// Stored secrets are deliberately not readable from JavaScript.
export const secretStore = {
  isConfigured: () => invoke<boolean>("gemini_api_key_configured"),
  save: (key: string) => invoke<void>("save_gemini_api_key", { key }),
  remove: () => invoke<void>("remove_gemini_api_key"),
};
