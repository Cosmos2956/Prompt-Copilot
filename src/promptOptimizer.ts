export type OptimizationMode = "light" | "smart" | "agent";

export type OptimizationRequest = {
  originalPrompt: string;
  mode: OptimizationMode;
};

export type OptimizationResult = {
  improvedPrompt: string;
  detectedTask?: string;
  changes?: string[];
};

export interface PromptOptimizer {
  optimize(request: OptimizationRequest): Promise<OptimizationResult>;
}

const MOCK_DELAY_MS = 200;

export class MockPromptOptimizer implements PromptOptimizer {
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    const prompt = request.originalPrompt.replace(/\r\n?/g, "\n").trim();
    if (!prompt) {
      throw new Error("Enter an original prompt first.");
    }

    await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));

    return { improvedPrompt: `Request:\n${prompt}` };
  }
}

export const promptOptimizer: PromptOptimizer = new MockPromptOptimizer();

export function createPromptOptimizer(): PromptOptimizer {
  const useMock =
    import.meta.env.DEV && import.meta.env.VITE_USE_MOCK_OPTIMIZER === "true";
  if (useMock) return new MockPromptOptimizer();
  return new GeminiPromptOptimizer();
}

export const configuredPromptOptimizer = createPromptOptimizer();
import { GeminiPromptOptimizer } from "./providers/geminiPromptOptimizer";
