# Prompt Copilot 1.00

Windows x64 release, with package version 1.0.0.

## Included

- Floating prompt editor with selected-text capture through Ctrl+Shift+Space.
- Gemini-powered rewriting in Light, Smart, and Agent modes.
- Improve, Run in ChatGPT, Improve & Run, and manual copy.
- Local history of the last 50 successful rewrites.
- Windows Credential Manager storage for the Gemini API key.
- Tray controls, optional startup with Windows, and single-instance handling.

## Installation

Download `Prompt.Copilot_1.0.0_x64-setup.exe` and run it. Quit any existing Prompt Copilot instance through the tray menu before updating. The installer targets the current Windows user and installs WebView2 if missing.

`prompt-copilot-1.00.exe` is the standalone alternative. It also requires WebView2. `SHA256SUMS.txt` contains checksums for both executables.

## Requirements and limitations

Automatic sending supports only ChatGPT Desktop on Windows. Sign in and open the intended conversation before sending. Gemini rewriting requires internet access and a Gemini API key with access to `gemini-3.5-flash-lite`; a ChatGPT subscription does not provide that key.

This build is unsigned. Automatic sending depends on the message controls exposed by your installed ChatGPT Desktop version. Live compatibility, startup, and installer behavior must be checked on the target machine. If sending fails, check the draft and conversation before retrying, or copy and paste manually.

See README.md in the repository for setup, shortcuts, data handling, troubleshooting, and development instructions.
