import { invoke } from "@tauri-apps/api/core";

export interface ChatGPTDesktopController {
  runPrompt(prompt: string): Promise<void>;
}

export const chatgptDesktopController: ChatGPTDesktopController = {
  runPrompt: (prompt) => invoke("run_prompt_in_chatgpt", { prompt }),
};
