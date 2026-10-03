import { MISSING_API_KEY_MESSAGE } from "./secretStore";

// Show actionable summaries, never raw IPC/Windows diagnostics.
export function actionFeedback(message: string): {
  text: string;
  settings: boolean;
} {
  if (message === MISSING_API_KEY_MESSAGE)
    return { text: "Gemini API key missing.", settings: true };
  if (/api key|credential|authentication/i.test(message))
    return { text: "Check your Gemini API key in Settings.", settings: true };
  if (/draft changed/i.test(message))
    return {
      text: "The pasted ChatGPT draft changed before submission. Nothing was sent; review the draft.",
      settings: false,
    };
  if (/unsent draft/i.test(message))
    return {
      text: "Select the text to replace in ChatGPT’s message box, then run the prompt. Nothing was pasted.",
      settings: false,
    };
  if (/interrupted|all keyboard input/i.test(message))
    return {
      text: "Sending was interrupted. Check ChatGPT before retrying.",
      settings: false,
    };
  if (/several ChatGPT|message boxes/i.test(message))
    return {
      text: "Open only the intended ChatGPT window and focus its message box.",
      settings: false,
    };
  if (/pasted text|clipboard/i.test(message))
    return {
      text: "Paste could not be verified. Check the ChatGPT draft before retrying.",
      settings: false,
    };
  if (
    /does not expose readable message text|Could not read the ChatGPT message box/i.test(
      message,
    )
  )
    return {
      text: "ChatGPT’s message text could not be read. Nothing was submitted; copy the prompt and paste it manually.",
      settings: false,
    };
  if (
    /lost focus|did not receive keyboard focus|Could not focus the ChatGPT message box/i.test(
      message,
    )
  )
    return {
      text: "The ChatGPT message box did not keep focus. Click its input and retry.",
      settings: false,
    };
  if (/no longer available/i.test(message))
    return {
      text: "The ChatGPT message box became unavailable. Check the conversation before retrying.",
      settings: false,
    };
  if (/message box|composer|readable message/i.test(message))
    return {
      text: "Could not identify the ChatGPT message box. Open the conversation and focus its input.",
      settings: false,
    };
  if (/ChatGPT|foreground|accessibility/i.test(message))
    return {
      text: "Could not focus ChatGPT. Open it and try again.",
      settings: false,
    };
  if (/held|modifier|shortcut keys/i.test(message))
    return {
      text: "Release the shortcut keys, then try again.",
      settings: false,
    };
  if (/null characters/i.test(message))
    return {
      text: "Remove null characters from the prompt, then retry.",
      settings: false,
    };
  if (/blocked/i.test(message))
    return {
      text: "Gemini blocked this request. Rephrase the prompt and retry.",
      settings: false,
    };
  if (/length limit|truncat/i.test(message))
    return {
      text: "Gemini’s rewrite was cut off. Shorten the prompt or try Light mode.",
      settings: false,
    };
  if (/quota|rate limit/i.test(message))
    return {
      text: "Gemini’s request limit was reached. Wait and retry.",
      settings: false,
    };
  if (/invalid or empty|malformed|complete optimization/i.test(message))
    return {
      text: "No complete rewrite was returned. Try Improve again.",
      settings: false,
    };
  if (/Gemini|network|server|timed out/i.test(message))
    return {
      text: "Gemini request failed. Try Improve again.",
      settings: false,
    };
  return {
    text: "The request failed. Try again; check ChatGPT first if sending had started.",
    settings: false,
  };
}
