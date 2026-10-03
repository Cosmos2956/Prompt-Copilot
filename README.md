# Prompt Copilot

Prompt Copilot is a personal Windows desktop utility that rewrites rough instructions into clearer AI prompts while preserving your intent. It runs in the system tray and opens a floating editor with a keyboard shortcut.

**This build is designed for ChatGPT Desktop on Windows.** Run in ChatGPT and Improve & Run send prompts to the installed ChatGPT Desktop app. They do not support ChatGPT in a browser, Codex, Claude, or other AI applications. You can still copy an improved prompt and paste it elsewhere manually.

Prompt rewriting uses the Google Gemini API. ChatGPT Desktop receives the finished prompt and answers it in your current conversation. A Gemini API key is required for rewriting; this build does not use an OpenAI API key or your ChatGPT subscription to generate rewrites.

## Requirements

- Windows 10 or 11. The current installer targets x64 Windows.
- ChatGPT Desktop installed and signed in for automatic sending.
- A Gemini API key with access to the configured model, `gemini-3.5-flash-lite`.
- Internet access for Gemini requests and ChatGPT responses.
- Microsoft Edge WebView2 Runtime. The installer downloads it if missing, which requires internet access.

The app stores settings locally, but rewriting is an online operation. It is not an offline AI model.

## Installation

Download the installer from [GitHub Releases](https://github.com/Cosmos2956/Prompt-Copilot/releases/latest), then run `Prompt.Copilot_1.0.0_x64-setup.exe`, then launch Prompt Copilot from the Start Menu.

The installer installs for your Windows account, with `%LOCALAPPDATA%\Prompt Copilot` as the default folder. This personal build is unsigned.

Before updating, quit the running app through its tray menu. Closing the floating window only hides it. A running older instance can otherwise remain active after installation.

A standalone executable is also produced when building a release. Run either the installed app or the standalone executable, and quit it before switching versions.

## First-time setup

1. Open ChatGPT Desktop, sign in, and open the conversation you want to use.
2. Launch Prompt Copilot and open Settings using the gear button or tray menu.
3. Enter your Gemini API key and select Save.
4. Choose a default mode if desired. Smart is the initial default.
5. Leave Automatically send after optimization off if you want to review rewrites before sending.

Saving a key stores it in Windows Credential Manager for your Windows account. Saving does not test authentication; the first Improve request checks whether the key and model access work. Settings lets you replace or remove the key.

## Using the app

1. Select the rough prompt in the application you are working in.
2. Press **Ctrl+Shift+Space** to open Prompt Copilot and capture the selected text.
3. Review or edit Original Prompt, then choose Light, Smart, or Agent.
4. Select Improve to generate a rewrite for review, or Improve & Run to rewrite and send it to ChatGPT Desktop.
5. Edit Improved Prompt if needed, then copy it or select Run in ChatGPT.

You can also type or paste directly into Original Prompt. Opening from the tray shows the editor without capturing text. If selected-text capture fails or finds no text, the existing prompt stays in place.

### Actions

- **Improve:** rewrites Original Prompt and displays the result. When automatic sending is enabled in Settings, it also sends the result to ChatGPT.
- **Run in ChatGPT:** sends Improved Prompt when it contains text; otherwise, it sends Original Prompt. It does not rewrite the text first.
- **Improve & Run:** rewrites Original Prompt, then sends the result. After a successful send, both prompt boxes clear. If sending fails, the text remains available for retry.
- **Copy:** copies Improved Prompt to the clipboard for manual use.
- **Clear:** empties both prompt boxes and returns focus to Original Prompt.
- **History:** opens saved rewrites. Restoring an entry does not send it.

Both prompt fields are editable when an action is not running. To generate another version, select Improve again. Ordinary Improve and Run in ChatGPT retain the editor contents.

### Modes

| Mode  | What it asks the optimizer to do                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| Light | Clean up wording and clarity with minimal expansion.                                                       |
| Smart | Clarify the goal, useful constraints, and expected output.                                                 |
| Agent | Prepare instructions for an autonomous agent, with completion checks and stopping conditions where useful. |

The optimizer is instructed to rewrite the prompt, not answer it, and to preserve supplied requirements without inventing facts. Review the result before sending when exact wording matters.

### Keyboard shortcuts

| Shortcut         | Action                                                               |
| ---------------- | -------------------------------------------------------------------- |
| Ctrl+Shift+Space | Toggle the floating window; capture selected text when opening.      |
| Ctrl+Enter       | Improve. Also send if automatic sending is enabled.                  |
| Ctrl+Shift+Enter | Improve & Run.                                                       |
| Ctrl+1           | Select Light mode.                                                   |
| Ctrl+2           | Select Smart mode.                                                   |
| Ctrl+3           | Select Agent mode.                                                   |
| Escape           | Return from Settings or History; otherwise hide the floating window. |

Shortcuts are fixed in this build.

## ChatGPT Desktop integration

The Windows controller finds the ChatGPT Desktop window, focuses its message box, pastes the prompt, verifies the draft text, and sends Enter. It uses Windows UI Automation and keyboard input. It does not call the OpenAI API, choose a ChatGPT model, or switch conversations.

Keep only the intended ChatGPT window open and select the conversation before sending. With an existing unsent draft, select the text you intend to replace in ChatGPT's message box. The controller stops if it cannot establish a replacement selection or verify the draft.

Automatic sending depends on the controls exposed by the installed ChatGPT Desktop version. Composer recognition still needs live Windows verification; a successful build alone does not prove compatibility with your installed version. If recognition or verification fails, use Copy and paste the prompt manually.

Failed or interrupted sends are not retried automatically. Check the ChatGPT draft and conversation before retrying to avoid duplicate submissions. A reported successful send means the controller sent Enter after verification; it does not confirm that ChatGPT generated a response.

## Settings and system tray

Settings contains the Gemini key, default mode, startup toggle, and automatic sending toggle.

Changing the default mode applies it immediately and saves it for future launches. Switching modes in the main editor applies only to the current session. Automatic sending is off by default; Improve & Run always sends after a successful rewrite.

The tray menu offers Open Prompt Copilot, Settings, Start with Windows, and Quit. Start with Windows is off until enabled. When enabled, sign-in launches keep the window hidden and register the global shortcut.

Escape and the window close action hide the editor without exiting. Use Quit in the tray menu to stop the app. Only one instance runs at a time; another launch brings the existing instance forward.

## Data and privacy

- The Gemini API key is stored in Windows Credential Manager under `com.promptcopilot.desktop/gemini_api_key`.
- Settings and the last 50 successful rewrites are stored locally in the app's WebView storage. History includes original text, improved text, mode, and timestamp. It is not stored in Credential Manager.
- Original prompts are sent to Google's Gemini API when you request a rewrite. Prompts sent through Run in ChatGPT go to the current ChatGPT Desktop conversation.
- This app has no separate login, cloud database, telemetry, or analytics.
- History entries can be deleted individually. Clear All asks for confirmation. A successful rewrite remains in history even if sending later fails.
- Hiding the window preserves current editor text in memory. Quitting loses unsaved editor contents; saved history remains.

Selected-text capture uses the Windows clipboard and preserves plain-text Unicode, line breaks, and indentation. Clipboard restoration during capture is best effort for plain text; it does not preserve every clipboard format. Copy and automatic sending place prompt text on the clipboard.

Uninstall normally retains local settings and history unless Delete app data is selected. Credential Manager keys remain for reinstall; remove the key in Settings before uninstalling if you want to delete it.

## Troubleshooting

| Problem                                  | What to check                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Global shortcut does not work            | Quit other Prompt Copilot builds, including older standalone copies, then restart. Another application may also own the shortcut. |
| No text appears after capture            | Select copyable text first, or paste it into Original Prompt manually.                                                            |
| Gemini key error                         | Replace the key in Settings and confirm it has access to the configured model. Saving alone does not validate it.                 |
| Request limit or network error           | Check connectivity and API quota, then retry.                                                                                     |
| Rewrite is cut off                       | Shorten the original prompt or try Light mode.                                                                                    |
| ChatGPT message box cannot be identified | Open the intended conversation, click its input, and retry. Use manual copy and paste if the controls cannot be read.             |
| Existing draft prevents sending          | Select the text to replace in ChatGPT's message box, or clear the draft yourself.                                                 |
| Sending is interrupted                   | Inspect ChatGPT before retrying. Release shortcut keys and keep the intended message box focused.                                 |
| App still runs after closing the window  | This is expected. Use the tray menu's Quit action.                                                                                |
| An update appears to run old code        | Quit the existing instance, then launch the installed version again.                                                              |

## Development

The app uses Tauri 2, React, TypeScript, Vite, and Tailwind. Rust handles native Windows behavior, API transport, and credential storage. No application server is required.

Install Node.js compatible with Vite 7, pnpm, Rust, Microsoft C++ Build Tools with the Windows SDK, and WebView2. Run these commands from the repository root in PowerShell:

```powershell
pnpm install
powershell -NoProfile -ExecutionPolicy Bypass -File ./dev.ps1
```

The development script starts the frontend and native app together and uses project-local Rust tools when available. Quit other Prompt Copilot instances first. Keep the terminal open and stop development with Ctrl+C. Do not launch the debug executable directly; it depends on the development server.

For UI work without Gemini requests, the development-only mock optimizer can be enabled before starting:

```powershell
$env:VITE_USE_MOCK_OPTIMIZER = 'true'
powershell -NoProfile -ExecutionPolicy Bypass -File ./dev.ps1
```

The mock only wraps the input in a simple request; it does not perform an AI rewrite or disable ChatGPT sending. Remove the environment variable to restore normal optimization:

```powershell
Remove-Item Env:VITE_USE_MOCK_OPTIMIZER
```

### Checks

```powershell
pnpm format:check
pnpm check
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
pnpm build
```

`pnpm build` checks TypeScript and builds the frontend. Building the Windows app and installer is a separate step. Tests do not replace live checks of selection capture, tray behavior, startup, or ChatGPT sending.

### Build a Windows release

```powershell
pnpm release
```

The release script builds the native app and an NSIS installer in a separate target directory. Version 1.00 outputs are:

```text
src-tauri/target/installer/release/bundle/nsis/Prompt Copilot_1.0.0_x64-setup.exe
src-tauri/target/installer/release/prompt-copilot-1.00.exe
```

Application version metadata comes from `src-tauri/Cargo.toml`, currently `1.0.0`, displayed as Version 1.00. When releasing a new version, update `mainBinaryName` in `src-tauri/tauri.conf.json` to match the intended executable name. Preserve the app identifier `com.promptcopilot.desktop` and current-user installer mode so updates target the same installation.

After installing, verify tray actions, duplicate launch behavior, the global shortcut, saved settings and history, and ChatGPT sending. Enable Start with Windows and sign out and back in to check hidden startup. An explicit uninstall/reinstall requires enabling startup again.

### Source layout

```text
src/                       React interface, preferences, history, optimizer logic
src/providers/             Gemini configuration and provider implementations
src-tauri/src/             Windows capture, ChatGPT controller, tray, startup,
                           credential storage, and API transport
src-tauri/installer/        Installer hooks
tests/                    Automated frontend and behavior tests
dev.ps1                   Development launcher
release.ps1               Windows release builder
```

The active optimizer is Gemini. An OpenAI provider implementation exists in the source, but this build does not expose a provider switch in Settings.

## Release verification

GitHub Actions runs formatting, TypeScript checks, frontend tests, Rust checks and tests, and the frontend build. A version tag such as `v1.0.0` publishes the Windows installer, standalone executable, and SHA-256 checksums only after those checks pass. The tag must match the version in `src-tauri/Cargo.toml`. The initial version 1.00 release also publishes from `main` after checks pass, and creates `v1.0.0` at that exact source commit. Later pushes do not replace that release.

To verify a downloaded executable in PowerShell, compare its hash with `SHA256SUMS.txt` from the same release:

```powershell
Get-FileHash './Prompt.Copilot_1.0.0_x64-setup.exe' -Algorithm SHA256
```
