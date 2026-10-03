import { invoke } from "@tauri-apps/api/core";
import type {
  OptimizationRequest,
  OptimizationResult,
  PromptOptimizer,
} from "../promptOptimizer";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_GENERATION_CONFIG,
  GEMINI_OPTIMIZER_INSTRUCTION,
} from "./geminiConfig";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class GeminiPromptOptimizer implements PromptOptimizer {
  async optimize(request: OptimizationRequest): Promise<OptimizationResult> {
    const originalPrompt = request.originalPrompt
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!originalPrompt || originalPrompt.includes("\0")) {
      throw new Error(
        "Enter a non-empty original prompt without null characters.",
      );
    }
    if (!["light", "smart", "agent"].includes(request.mode)) {
      throw new Error("Choose Light, Smart, or Agent mode.");
    }
    let response: unknown;
    try {
      // Retry only truncated generations, before the caller can submit anything.
      // A second truncated result still fails closed below.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await invoke<unknown>("gemini_request", {
          model: DEFAULT_GEMINI_MODEL,
          body: {
            systemInstruction: {
              parts: [
                {
                  text: `${GEMINI_OPTIMIZER_INSTRUCTION}\nSelected mode: ${request.mode.toUpperCase()}.${attempt === 1 ? "\nThe previous rewrite was cut off. Return only one concise improvedPrompt field. Omit metadata and alternatives. Honor any prompt-length limit specified by the user." : ""}`,
                },
              ],
            },
            contents: [{ role: "user", parts: [{ text: originalPrompt }] }],
            generationConfig: GEMINI_GENERATION_CONFIG,
          },
        });
        const firstCandidate =
          isRecord(response) && Array.isArray(response.candidates)
            ? response.candidates[0]
            : undefined;
        if (
          !isRecord(firstCandidate) ||
          firstCandidate.finishReason !== "MAX_TOKENS"
        )
          break;
      }
    } catch (cause) {
      // The native transport returns fixed messages, never raw provider errors.
      throw new Error(
        typeof cause === "string"
          ? cause
          : "The Gemini request could not be completed. Try again.",
      );
    }

    const candidate =
      isRecord(response) && Array.isArray(response.candidates)
        ? response.candidates[0]
        : undefined;
    const feedback = isRecord(response) ? response.promptFeedback : undefined;
    if (
      isRecord(feedback) &&
      typeof feedback.blockReason === "string" &&
      feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
    ) {
      throw new Error(
        "Gemini blocked this prompt. Rephrase it and try again. Nothing was sent.",
      );
    }
    if (isRecord(candidate) && candidate.finishReason === "MAX_TOKENS") {
      throw new Error(
        "Gemini reached the response length limit before finishing. Shorten the original prompt or try Light mode. Nothing was sent.",
      );
    }
    if (
      isRecord(candidate) &&
      [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
      ].includes(String(candidate.finishReason))
    ) {
      throw new Error(
        "Gemini blocked the generated rewrite. Rephrase the original prompt and try again. Nothing was sent.",
      );
    }
    const content = isRecord(candidate) ? candidate.content : undefined;
    if (
      !isRecord(candidate) ||
      candidate.finishReason !== "STOP" ||
      !isRecord(content) ||
      !Array.isArray(content.parts)
    ) {
      throw new Error(
        "Gemini stopped without a complete rewrite. Try again. Nothing was sent.",
      );
    }
    const text = content.parts
      .filter(
        (part) =>
          isRecord(part) &&
          part.thought !== true &&
          typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(
        "Gemini returned a malformed optimization result. Try again.",
      );
    }
    if (!isRecord(result) || typeof result.improvedPrompt !== "string") {
      throw new Error(
        "Gemini returned a malformed optimization result. Try again.",
      );
    }
    if (!result.improvedPrompt.trim() || result.improvedPrompt.includes("\0")) {
      throw new Error(
        "Gemini returned an empty or invalid improved prompt. Nothing was sent.",
      );
    }
    return {
      improvedPrompt: result.improvedPrompt.trim(),
    };
  }
}
