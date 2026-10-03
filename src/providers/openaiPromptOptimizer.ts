import { invoke } from "@tauri-apps/api/core";
import type {
  OptimizationRequest,
  OptimizationResult,
  PromptOptimizer,
} from "../promptOptimizer";

const OPENAI_MODEL = "gpt-5";
const MAX_RETRIES = 1;

type OpenAIResponse = {
  output?: Array<{
    content?: Array<{ text?: string; type?: string }>;
    type?: string;
  }>;
};

const modeInstructions: Record<OptimizationRequest["mode"], string> = {
  light:
    "Preserve almost all wording. Make only the smallest changes needed to improve clarity and remove ambiguity.",
  smart:
    "Clarify the objective, add useful structure and constraints when they are supported by the request, and remain concise.",
  agent:
    "Rewrite for an autonomous work agent. Include the objective, relevant context, constraints, verification, definition of done, and a stopping condition only when they follow from the request.",
};

const systemInstruction = `You improve rough prompts while preserving the user's actual intent.
Never invent facts, deadlines, sources, preferences, technical requirements, or files.
Do not add generic expert-role filler. Keep the result as concise as the task allows.
Return only the requested JSON object.`;

export class OpenAIPromptOptimizer implements PromptOptimizer {
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    const originalPrompt = request.originalPrompt
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!originalPrompt) {
      throw new Error("Enter an original prompt first.");
    }

    const body = {
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `${systemInstruction}\nSelected mode: ${request.mode.toUpperCase()}. ${modeInstructions[request.mode]}`,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: originalPrompt }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "prompt_optimization",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              improvedPrompt: { type: "string" },
              detectedTask: { type: "string" },
              changes: { type: "array", items: { type: "string" } },
            },
            required: ["improvedPrompt", "detectedTask", "changes"],
          },
        },
      },
      store: false,
    };

    const response = await this.request(body);
    const jsonText = response?.output
      ?.flatMap((item) => item.content ?? [])
      .find((content) => content.type === "output_text" || content.text)?.text;
    if (!jsonText) {
      throw new Error("OpenAI returned no optimization result.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("OpenAI returned an invalid optimization result.");
    }

    if (!isOptimizationResult(parsed)) {
      throw new Error("OpenAI returned an incomplete optimization result.");
    }
    return {
      improvedPrompt: parsed.improvedPrompt.trim(),
      detectedTask: parsed.detectedTask || undefined,
      changes: parsed.changes.length ? parsed.changes : undefined,
    };
  }

  private async request(body: object): Promise<OpenAIResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await invoke<{
          status: number;
          data: OpenAIResponse | null;
        }>("openai_request", {
          body,
        });
        if (response.status >= 200 && response.status < 300 && response.data) {
          return response.data;
        }
        lastError = new Error(
          response.status === 401 || response.status === 403
            ? "OpenAI could not authenticate this key. Check or replace it in Settings."
            : `OpenAI request failed with status ${response.status}.`,
        );
        if (response.status < 500 && response.status !== 429) break;
      } catch (cause) {
        // Native errors are fixed user-facing messages, never request/error dumps.
        lastError = new Error(
          typeof cause === "string"
            ? cause
            : "The OpenAI request could not be completed.",
        );
        // Missing credentials and storage errors must not be retried.
        if (
          !lastError.message.startsWith("Could not connect to OpenAI") &&
          !lastError.message.startsWith("The OpenAI request timed out")
        )
          break;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error("The OpenAI request failed.");
  }
}

function isOptimizationResult(value: unknown): value is {
  improvedPrompt: string;
  detectedTask: string;
  changes: string[];
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.improvedPrompt === "string" &&
    typeof result.detectedTask === "string" &&
    Array.isArray(result.changes) &&
    result.changes.every((change) => typeof change === "string")
  );
}
