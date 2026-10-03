use std::{
    mem::size_of,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use windows::Win32::{
    Foundation::{
        CloseHandle, GlobalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, HWND, LPARAM,
    },
    Storage::Packaging::Appx::GetPackageFamilyName,
    System::{
        Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard,
            SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::{
        Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
            TextPatternRangeEndpoint_Start, TreeScope_Descendants, UIA_DocumentControlTypeId,
            UIA_EditControlTypeId, UIA_TextPatternId, UIA_ValuePatternId,
        },
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN,
            VK_SHIFT, VK_V,
        },
        WindowsAndMessaging::{
            EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
            IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
        },
    },
};

const PACKAGE_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";
const APP_ID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const WINDOW_LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);
const FOREGROUND_TIMEOUT: Duration = Duration::from_millis(350);
const COMPOSER_FOCUS_TIMEOUT: Duration = Duration::from_millis(350);
const CLIPBOARD_OPEN_TIMEOUT: Duration = Duration::from_millis(250);
const PASTE_VERIFY_TIMEOUT: Duration = Duration::from_millis(600);
const KEY_RELEASE_TIMEOUT: Duration = Duration::from_millis(800);

pub struct ChatGPTDesktopController;

impl ChatGPTDesktopController {
    pub fn run_prompt(&self, prompt: &str, clipboard_owner: isize) -> Result<(), String> {
        if prompt.trim().is_empty() {
            return Err("Enter an original prompt first.".into());
        }
        if prompt.contains('\0') {
            return Err("Remove null characters from the prompt before sending.".into());
        }

        // UI Automation uses COM and runs on this dedicated blocking thread.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|error| format!("Could not initialize Windows accessibility: {error}"))?;
        }
        let result = self.run_prompt_inner(prompt, HWND(clipboard_owner as *mut _));
        if let Err(error) = &result {
            eprintln!("[ChatGPT controller] Stopped: {error}");
        }
        unsafe { CoUninitialize() };
        result
    }

    fn run_prompt_inner(&self, prompt: &str, clipboard_owner: HWND) -> Result<(), String> {
        let hwnd = self.focus_chatgpt()?;
        let composer = self.focus_composer(hwnd)?;
        let replacement = replacement_target(&composer)?;
        let expected = replacement.expected(prompt);
        let clipboard_sequence = self.copy_to_clipboard(prompt, clipboard_owner)?;
        self.paste_prompt(hwnd, &composer, clipboard_sequence, prompt, &replacement)?;
        self.verify_paste(hwnd, &composer, &expected)?;
        self.submit_prompt(hwnd, &composer, &expected)
    }

    fn focus_chatgpt(&self) -> Result<HWND, String> {
        let mut hwnd = find_chatgpt_window()?;
        if hwnd.is_none() {
            eprintln!(
                "[ChatGPT controller] No ChatGPT window found; attempting registered app launch"
            );
            Command::new("explorer.exe")
                .arg(format!("shell:AppsFolder\\{APP_ID}"))
                .spawn()
                .map_err(|error| {
                    format!("ChatGPT is not running and could not be launched: {error}")
                })?;
            let deadline = Instant::now() + WINDOW_LAUNCH_TIMEOUT;
            while Instant::now() < deadline {
                thread::sleep(POLL_INTERVAL);
                hwnd = find_chatgpt_window()?;
                if hwnd.is_some() {
                    break;
                }
            }
        }
        let hwnd =
            hwnd.ok_or("Could not find the ChatGPT desktop window. Open ChatGPT, then try again.")?;
        eprintln!("[ChatGPT controller] Found ChatGPT window {:?}", hwnd);
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
        let deadline = Instant::now() + FOREGROUND_TIMEOUT;
        while ensure_foreground(hwnd).is_err() && Instant::now() < deadline {
            thread::sleep(POLL_INTERVAL);
        }
        ensure_foreground(hwnd).map_err(|_| {
            "Windows did not allow ChatGPT to take focus. Open it and try again.".to_string()
        })?;
        eprintln!("[ChatGPT controller] ChatGPT is foreground");
        Ok(hwnd)
    }

    fn focus_composer(&self, hwnd: HWND) -> Result<IUIAutomationElement, String> {
        ensure_foreground(hwnd)?;
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("Could not inspect ChatGPT controls: {error}"))?;
        let root = unsafe { automation.ElementFromHandle(hwnd) }
            .map_err(|error| format!("Could not inspect ChatGPT window: {error}"))?;
        let condition = unsafe { automation.CreateTrueCondition() }
            .map_err(|error| format!("Could not inspect ChatGPT controls: {error}"))?;
        let elements = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
            .map_err(|error| format!("Could not find the ChatGPT message box: {error}"))?;
        let count = unsafe { elements.Length() }.unwrap_or(0);
        let mut matches = Vec::new();
        for index in 0..count {
            let Ok(element) = (unsafe { elements.GetElement(index) }) else {
                continue;
            };
            let Ok(kind) = (unsafe { element.CurrentControlType() }) else {
                continue;
            };
            if kind != UIA_EditControlTypeId && kind != UIA_DocumentControlTypeId {
                continue;
            }
            if !unsafe { element.CurrentIsEnabled() }.is_ok_and(|value| value.as_bool())
                || !unsafe { element.CurrentIsOffscreen() }.is_ok_and(|value| !value.as_bool())
                || !unsafe { element.CurrentIsKeyboardFocusable() }
                    .is_ok_and(|value| value.as_bool())
            {
                continue;
            }
            let name = unsafe { element.CurrentName() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            let id = unsafe { element.CurrentAutomationId() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            let help = unsafe { element.CurrentHelpText() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            let name = name.to_ascii_lowercase();
            let id = id.to_ascii_lowercase();
            let help = help.to_ascii_lowercase();
            if is_composer_label(&name, &id) || is_composer_label(&help, "") {
                matches.push(element);
            }
        }
        eprintln!(
            "[ChatGPT controller] Composer candidates: {}",
            matches.len()
        );
        // Hidden/background composers must not make the active conversation ambiguous.
        // Never fall back to an arbitrary edit control, which could be search or Settings.
        let composer = if matches.len() == 1 {
            matches.pop().unwrap()
        } else {
            let focused: Vec<_> = matches
                .iter()
                .filter(|element| {
                    unsafe { element.CurrentHasKeyboardFocus() }.is_ok_and(|value| value.as_bool())
                })
                .collect();
            if focused.len() == 1 {
                focused[0].clone()
            } else if matches.is_empty() {
                return Err("No visible ChatGPT message box was recognized. Open the current conversation and click its message box, then try again. Nothing was sent.".into());
            } else {
                return Err("Several ChatGPT message boxes are visible. Click the message box in the intended conversation, then try again. Nothing was sent.".into());
            }
        };
        // Do not reclaim focus if the user switched apps during discovery.
        ensure_foreground(hwnd)?;
        unsafe { composer.SetFocus() }
            .map_err(|error| format!("Could not focus the ChatGPT message box: {error}"))?;
        let deadline = Instant::now() + COMPOSER_FOCUS_TIMEOUT;
        loop {
            ensure_foreground(hwnd)?;
            if unsafe { composer.CurrentHasKeyboardFocus() }.is_ok_and(|value| value.as_bool()) {
                break;
            }
            if Instant::now() >= deadline {
                return Err("The ChatGPT message box did not receive keyboard focus.".into());
            }
            thread::sleep(POLL_INTERVAL);
        }
        ensure_foreground(hwnd)?;
        eprintln!("[ChatGPT controller] Message composer focused");
        Ok(composer)
    }

    pub(crate) fn copy_to_clipboard(&self, prompt: &str, owner: HWND) -> Result<u32, String> {
        if prompt.contains('\0') {
            return Err("Remove null characters before copying.".into());
        }
        let utf16: Vec<u16> = prompt.encode_utf16().chain(std::iter::once(0)).collect();
        let sequence;
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, utf16.len() * size_of::<u16>())
                .map_err(|error| format!("Could not allocate clipboard text: {error}"))?;
            let pointer = GlobalLock(memory) as *mut u16;
            if pointer.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("Could not lock clipboard memory.".into());
            }
            pointer.copy_from_nonoverlapping(utf16.as_ptr(), utf16.len());
            let _ = GlobalUnlock(memory);
            let deadline = Instant::now() + CLIPBOARD_OPEN_TIMEOUT;
            let open_result = loop {
                match OpenClipboard(Some(owner)) {
                    Ok(()) => break Ok(()),
                    Err(error) if Instant::now() < deadline => {
                        let _ = error;
                        thread::sleep(POLL_INTERVAL);
                    }
                    Err(error) => break Err(error),
                }
            };
            if let Err(error) = open_result {
                let _ = GlobalFree(Some(memory));
                return Err(format!("Could not open the clipboard: {error}"));
            }
            let result = (|| {
                EmptyClipboard()
                    .map_err(|error| format!("Could not clear the clipboard: {error}"))?;
                SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0)))
                    .map_err(|error| format!("Could not copy the prompt: {error}"))?;
                // Capture our sequence while the clipboard is still locked.
                let sequence = GetClipboardSequenceNumber();
                Ok::<u32, String>(sequence)
            })();
            let _ = CloseClipboard();
            if result.is_err() {
                let _ = GlobalFree(Some(memory));
            }
            sequence = result?;
        }
        eprintln!(
            "[ChatGPT controller] Prompt copied to clipboard ({} UTF-16 units)",
            utf16.len() - 1
        );
        eprintln!(
            "[ChatGPT controller] Clipboard sequence recorded={sequence}, after close={}",
            unsafe { GetClipboardSequenceNumber() }
        );
        if sequence == 0 {
            return Err("Windows could not confirm the clipboard update.".into());
        }
        Ok(sequence)
    }

    fn paste_prompt(
        &self,
        hwnd: HWND,
        composer: &IUIAutomationElement,
        clipboard_sequence: u32,
        prompt: &str,
        replacement: &ReplacementTarget,
    ) -> Result<(), String> {
        wait_for_key_release(hwnd, composer)?;
        // Recheck both the draft and selection before replacing anything.
        if &replacement_target(composer)? != replacement {
            return Err("The ChatGPT draft changed or its selection changed before paste. Nothing was pasted.".into());
        }
        let confirmed_sequence = if unsafe { GetClipboardSequenceNumber() } == clipboard_sequence {
            clipboard_sequence
        } else {
            // Windows adds synthesized text formats on CloseClipboard, which
            // advances the sequence even when Unicode text is unchanged.
            crate::selection_capture::matching_text_sequence(hwnd.0 as isize, prompt)
                .ok_or("The clipboard text changed before paste; no keys were sent.")?
        };
        ensure_target(hwnd, composer)?;
        if unsafe { GetClipboardSequenceNumber() } != confirmed_sequence {
            return Err("The clipboard changed before paste; no keys were sent.".into());
        }
        send_keys(&[
            (VK_CONTROL, false),
            (VK_V, false),
            (VK_V, true),
            (VK_CONTROL, true),
        ])?;
        eprintln!("[ChatGPT controller] Paste keys sent");
        Ok(())
    }

    fn verify_paste(
        &self,
        hwnd: HWND,
        composer: &IUIAutomationElement,
        prompt: &str,
    ) -> Result<(), String> {
        let expected = normalized_lines(prompt);
        let deadline = Instant::now() + PASTE_VERIFY_TIMEOUT;
        loop {
            ensure_target(hwnd, composer)?;
            if normalized_lines(&read_composer_text(composer)?) == expected {
                eprintln!("[ChatGPT controller] Pasted text verified");
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Could not verify the pasted text in ChatGPT. It was not submitted; check the ChatGPT draft.".into());
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn submit_prompt(
        &self,
        hwnd: HWND,
        composer: &IUIAutomationElement,
        prompt: &str,
    ) -> Result<(), String> {
        if normalized_lines(&read_composer_text(composer)?) != normalized_lines(prompt) {
            return Err(
                "The ChatGPT draft changed after paste. It was not submitted; check the draft."
                    .into(),
            );
        }
        ensure_no_pressed_modifiers()?;
        ensure_target(hwnd, composer)?;
        send_keys(&[(VK_RETURN, false), (VK_RETURN, true)])?;
        eprintln!("[ChatGPT controller] Enter key sent");
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ReplacementTarget {
    before: String,
    selected: String,
    after: String,
}

impl ReplacementTarget {
    fn expected(&self, prompt: &str) -> String {
        format!("{}{}{}", self.before, prompt, self.after)
    }
}

fn replacement_target(composer: &IUIAutomationElement) -> Result<ReplacementTarget, String> {
    let draft = read_composer_text(composer)?;
    if draft.is_empty() {
        return Ok(ReplacementTarget {
            before: String::new(),
            selected: String::new(),
            after: String::new(),
        });
    }
    let read_selection = || -> windows::core::Result<ReplacementTarget> {
        unsafe {
            let pattern: IUIAutomationTextPattern =
                composer.GetCurrentPatternAs(UIA_TextPatternId)?;
            let selections = pattern.GetSelection()?;
            if selections.Length()? != 1 {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004005u32 as i32,
                )));
            }
            let selection = selections.GetElement(0)?;
            let document = pattern.DocumentRange()?;
            let before = document.Clone()?;
            before.MoveEndpointByRange(
                TextPatternRangeEndpoint_End,
                &selection,
                TextPatternRangeEndpoint_Start,
            )?;
            let after = document.Clone()?;
            after.MoveEndpointByRange(
                TextPatternRangeEndpoint_Start,
                &selection,
                TextPatternRangeEndpoint_End,
            )?;
            Ok(ReplacementTarget {
                before: before.GetText(-1)?.to_string(),
                selected: selection.GetText(-1)?.to_string(),
                after: after.GetText(-1)?.to_string(),
            })
        }
    };
    let target = read_selection().map_err(|error| {
        eprintln!("[ChatGPT controller] Selection read failed: {error}");
        "ChatGPT has an unsent draft. Select the text to replace before running this prompt."
    })?;
    if target.selected.is_empty() {
        return Err(
            "ChatGPT has an unsent draft. Select the text to replace before running this prompt."
                .into(),
        );
    }
    if normalized_lines(&format!(
        "{}{}{}",
        target.before, target.selected, target.after
    )) != normalized_lines(&draft)
    {
        return Err(
            "The ChatGPT draft changed while reading its selection. Nothing was pasted.".into(),
        );
    }
    Ok(target)
}

fn ensure_target(hwnd: HWND, composer: &IUIAutomationElement) -> Result<(), String> {
    ensure_foreground(hwnd)?;
    if !is_chatgpt_window(hwnd) {
        return Err("ChatGPT window changed; no keys were sent.".into());
    }
    if !unsafe { composer.CurrentHasKeyboardFocus() }.is_ok_and(|value| value.as_bool()) {
        return Err("ChatGPT message box lost focus; no keys were sent.".into());
    }
    if !unsafe { composer.CurrentIsEnabled() }.is_ok_and(|value| value.as_bool())
        || !unsafe { composer.CurrentIsOffscreen() }.is_ok_and(|value| !value.as_bool())
    {
        return Err("ChatGPT message box is no longer available. Submission stopped.".into());
    }
    Ok(())
}

fn is_composer_label(name: &str, id: &str) -> bool {
    let name = name.trim().trim_end_matches(['.', '\u{2026}']).trim_end();
    matches!(
        name,
        "message"
            | "message chatgpt"
            | "message codex"
            | "message composer"
            | "message input"
            | "ask anything"
            | "ask chatgpt"
            | "ask codex"
            | "work with chatgpt"
    ) || matches!(
        id,
        "prompt-textarea" | "chat-input" | "message-input" | "message-composer"
    )
}

fn read_composer_text(composer: &IUIAutomationElement) -> Result<String, String> {
    let text = read_raw_composer_text(composer)?;
    let name = unsafe { composer.CurrentName() }
        .map(|value| value.to_string())
        .unwrap_or_default();
    let class = unsafe { composer.CurrentClassName() }
        .map(|value| value.to_string())
        .unwrap_or_default();
    // Chromium includes this editor's placeholder paragraph in both text APIs.
    // The same words typed as a draft must remain a draft: require the separate
    // raw-tree placeholder marker, as well as a single matching paragraph.
    if has_class(&class, "ProseMirror") && placeholder_text_matches(&text, &name) {
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?;
        let walker = unsafe { automation.RawViewWalker() }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?;
        let first = unsafe { walker.GetFirstChildElement(composer) }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?;
        let last = unsafe { walker.GetLastChildElement(composer) }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?;
        let single_paragraph = unsafe { automation.CompareElements(&first, &last) }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?
            .as_bool();
        let paragraph_class = unsafe { first.CurrentClassName() }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?
            .to_string();
        if is_placeholder_paragraph(&paragraph_class, single_paragraph) {
            return Ok(String::new());
        }
    }
    Ok(text)
}

fn placeholder_text_matches(text: &str, label: &str) -> bool {
    !label.is_empty()
        && (text == label
            || text
                .strip_suffix("\r\n")
                .or_else(|| text.strip_suffix('\n'))
                .is_some_and(|content| content == label))
}

fn is_placeholder_paragraph(class: &str, single_paragraph: bool) -> bool {
    single_paragraph && has_class(class, "placeholder")
}

fn has_class(classes: &str, expected: &str) -> bool {
    classes.split_whitespace().any(|class| class == expected)
}

fn read_raw_composer_text(composer: &IUIAutomationElement) -> Result<String, String> {
    if let Ok(pattern) =
        unsafe { composer.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
    {
        return unsafe { pattern.CurrentValue() }
            .map(|value| value.to_string())
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"));
    }
    if let Ok(pattern) =
        unsafe { composer.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
    {
        let range = unsafe { pattern.DocumentRange() }
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"))?;
        return unsafe { range.GetText(-1) }
            .map(|value| value.to_string())
            .map_err(|error| format!("Could not read the ChatGPT message box: {error}"));
    }
    Err(
        "ChatGPT does not expose readable message text, so automatic submission was stopped."
            .into(),
    )
}
fn normalized_lines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn ensure_no_pressed_modifiers() -> Result<(), String> {
    for key in [
        VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, VK_RETURN, VK_V,
    ] {
        if unsafe { GetAsyncKeyState(key.0 as i32) } < 0 {
            return Err("Release held shortcut keys, then try again.".into());
        }
    }
    Ok(())
}

fn wait_for_key_release(hwnd: HWND, composer: &IUIAutomationElement) -> Result<(), String> {
    let deadline = Instant::now() + KEY_RELEASE_TIMEOUT;
    loop {
        ensure_target(hwnd, composer)?;
        match ensure_no_pressed_modifiers() {
            Ok(()) => return Ok(()),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => thread::sleep(POLL_INTERVAL),
        }
    }
}

fn ensure_foreground(hwnd: HWND) -> Result<(), String> {
    if unsafe { GetForegroundWindow() } != hwnd {
        Err("ChatGPT is no longer the foreground window; no keys were sent.".into())
    } else {
        Ok(())
    }
}

fn send_keys(keys: &[(VIRTUAL_KEY, bool)]) -> Result<(), String> {
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|(key, up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: *key,
                    dwFlags: if *up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    ..Default::default()
                },
            },
        })
        .collect();
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        // A partial Ctrl+V sequence could leave Ctrl down. Release injected keys.
        let releases: Vec<INPUT> = keys[..sent as usize]
            .iter()
            .filter(|(_, up)| !up)
            .map(|(key, _)| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: *key,
                        dwFlags: KEYEVENTF_KEYUP,
                        ..Default::default()
                    },
                },
            })
            .collect();
        unsafe { SendInput(&releases, size_of::<INPUT>() as i32) };
        Err("Keyboard input was interrupted. Check the ChatGPT draft or conversation before retrying.".into())
    } else {
        Ok(())
    }
}

fn find_chatgpt_window() -> Result<Option<HWND>, String> {
    let mut found: Vec<HWND> = Vec::new();
    unsafe extern "system" fn callback(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
        let found = &mut *(data.0 as *mut Vec<HWND>);
        if is_chatgpt_window(hwnd) {
            found.push(hwnd);
        }
        true.into()
    }
    unsafe { EnumWindows(Some(callback), LPARAM(&mut found as *mut _ as isize)) }
        .map_err(|error| format!("Could not inspect desktop windows: {error}"))?;
    let foreground = unsafe { GetForegroundWindow() };
    if found.contains(&foreground) {
        return Ok(Some(foreground));
    }
    match found.len() {
        0 => Ok(None),
        1 => Ok(found.pop()),
        _ => Err("Several ChatGPT windows are open. Keep only the intended window open, then try again. Nothing was sent.".into()),
    }
}

fn is_chatgpt_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let mut title = [0u16; 256];
        let title_length = GetWindowTextW(hwnd, &mut title);
        if title_length == 0
            || !String::from_utf16_lossy(&title[..title_length as usize]).contains("ChatGPT")
        {
            return false;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid != 0 && is_chatgpt_process(pid)
    }
}

fn is_chatgpt_process(pid: u32) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut length = 0;
        let status = GetPackageFamilyName(process, &mut length, None);
        if status != ERROR_INSUFFICIENT_BUFFER || length == 0 {
            let _ = CloseHandle(process);
            return false;
        }
        let mut buffer = vec![0u16; length as usize];
        let status = GetPackageFamilyName(
            process,
            &mut length,
            Some(windows::core::PWSTR(buffer.as_mut_ptr())),
        );
        let _ = CloseHandle(process);
        status == ERROR_SUCCESS
            && String::from_utf16_lossy(&buffer[..length.saturating_sub(1) as usize])
                == PACKAGE_FAMILY
    }
}

#[cfg(test)]
mod tests {
    use super::{is_composer_label, normalized_lines};

    #[test]
    fn composer_matching_rejects_other_prompt_editors() {
        assert!(is_composer_label("message", ""));
        assert!(is_composer_label("", "prompt-textarea"));
        assert!(is_composer_label("work with chatgpt", ""));
        assert!(!is_composer_label("work with chatgpt settings", ""));
        assert!(!is_composer_label("system prompt", ""));
        assert!(!is_composer_label("model selector", ""));
    }

    #[test]
    #[ignore = "Focus and read the installed ChatGPT editor; never types, pastes, or submits"]
    fn inspect_installed_composer() {
        use super::*;
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        let result = (|| {
            let hwnd = find_chatgpt_window()?.ok_or("ChatGPT is not open")?;
            let composer = ChatGPTDesktopController.focus_composer(hwnd)?;
            let text = read_composer_text(&composer)?;
            if let Ok(expected) = std::env::var("PROMPT_COPILOT_TEST_DRAFT") {
                if text != expected {
                    return Err("Editor text does not exactly match the synthetic draft".into());
                }
                eprintln!("Focused composer reads the exact synthetic draft; draft protection remains active");
            } else {
                if !text.is_empty() {
                    return Err("Expected an empty editor for this acceptance check".into());
                }
                eprintln!("Focused composer is correctly recognized as empty");
            }
            Ok::<(), String>(())
        })();
        unsafe { CoUninitialize() };
        result.unwrap();
    }

    #[test]
    fn pasted_text_comparison_accepts_windows_line_endings() {
        assert_eq!(normalized_lines("one\r\ntwo"), normalized_lines("one\ntwo"));
    }

    #[test]
    fn replacement_preserves_unselected_unicode_and_line_breaks() {
        let target = super::ReplacementTarget {
            before: "Before 🌟\n".into(),
            selected: "old draft".into(),
            after: "\nAfter café".into(),
        };
        assert_eq!(
            target.expected("new\r\ntext"),
            "Before 🌟\nnew\r\ntext\nAfter café"
        );
        let all = super::ReplacementTarget {
            before: String::new(),
            selected: "entire draft".into(),
            after: String::new(),
        };
        assert_eq!(all.expected("replacement"), "replacement");
    }

    #[test]
    #[ignore = "Replaces selections in a synthetic empty-editor fixture and clears it; never submits"]
    fn replace_selection_without_submission() {
        use super::*;
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        let result = (|| {
            let controller = ChatGPTDesktopController;
            let hwnd = controller.focus_chatgpt()?;
            let composer = controller.focus_composer(hwnd)?;
            let fixture = "Before café old draft after 🌟";
            let draft = read_composer_text(&composer)?;
            if !draft.is_empty() && draft != fixture {
                return Err("Existing draft preserved; fixture requires an empty editor".into());
            }
            if draft.is_empty() {
                let empty = replacement_target(&composer)?;
                let sequence = controller.copy_to_clipboard(fixture, hwnd)?;
                controller.paste_prompt(hwnd, &composer, sequence, fixture, &empty)?;
                controller.verify_paste(hwnd, &composer, fixture)?;
                assert!(
                    replacement_target(&composer).is_err(),
                    "A caret must not authorize overwriting a draft"
                );
            }
            let pattern: IUIAutomationTextPattern =
                unsafe { composer.GetCurrentPatternAs(UIA_TextPatternId) }
                    .map_err(|e| e.to_string())?;
            let document = unsafe { pattern.DocumentRange() }.map_err(|e| e.to_string())?;
            let selection =
                unsafe { document.FindText(&windows::core::BSTR::from("old draft"), false, false) }
                    .map_err(|e| e.to_string())?;
            unsafe { selection.Select() }.map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(150));
            thread::sleep(Duration::from_millis(150));
            let target = replacement_target(&composer)?;
            assert_eq!(target.selected, "old draft");
            let prompt = "new input";
            let expected = target.expected(prompt);
            assert_eq!(expected, "Before café new input after 🌟");
            let sequence = controller.copy_to_clipboard(prompt, hwnd)?;
            // Moving the selection must invalidate the captured replacement.
            unsafe { document.Select() }.map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(150));
            assert!(controller
                .paste_prompt(hwnd, &composer, sequence, prompt, &target)
                .is_err());
            assert_eq!(read_composer_text(&composer)?, fixture);
            unsafe { selection.Select() }.map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(150));
            controller.paste_prompt(hwnd, &composer, sequence, prompt, &target)?;
            controller.verify_paste(hwnd, &composer, &expected)?;
            // Selection survives handing focus to the Copilot window and back.
            let document = unsafe { pattern.DocumentRange() }.map_err(|e| e.to_string())?;
            unsafe { document.Select() }.map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(150));
            if let Ok(owner) = std::env::var("PROMPT_COPILOT_TEST_OWNER") {
                let owner = HWND(owner.parse::<isize>().map_err(|e| e.to_string())? as *mut _);
                unsafe {
                    let _ = ShowWindow(owner, SW_RESTORE);
                    let _ = SetForegroundWindow(owner);
                }
                thread::sleep(Duration::from_millis(200));
                controller.focus_chatgpt()?;
                controller.focus_composer(hwnd)?;
            }
            let target = replacement_target(&composer)?;
            assert_eq!(target.selected, expected);
            let final_prompt = "Prompt Copilot replacement test — do not send.";
            let sequence = controller.copy_to_clipboard(final_prompt, hwnd)?;
            controller.paste_prompt(hwnd, &composer, sequence, final_prompt, &target)?;
            controller.verify_paste(hwnd, &composer, final_prompt)?;
            let document = unsafe { pattern.DocumentRange() }.map_err(|e| e.to_string())?;
            unsafe { document.Select() }.map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(150));
            ensure_target(hwnd, &composer)?;
            send_keys(&[
                (windows::Win32::UI::Input::KeyboardAndMouse::VK_BACK, false),
                (windows::Win32::UI::Input::KeyboardAndMouse::VK_BACK, true),
            ])?;
            controller.verify_paste(hwnd, &composer, "")?;
            eprintln!("Partial and full selection replacement verified; synthetic draft cleared. No submission attempted.");
            Ok::<(), String>(())
        })();
        unsafe { CoUninitialize() };
        result.unwrap();
    }

    #[test]
    #[ignore = "Writes a synthetic draft to an empty ChatGPT editor; never submits"]
    fn paste_without_submission() {
        use super::*;
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        let result = (|| {
            let controller = ChatGPTDesktopController;
            let hwnd = controller.focus_chatgpt()?;
            let composer = controller.focus_composer(hwnd)?;
            let before = read_composer_text(&composer)?;
            eprintln!(
                "After window focus and editor focus: draft_empty={}",
                before.is_empty()
            );
            if !before.is_empty() {
                return Err(
                    "Existing draft preserved; dry run stopped before clipboard or input".into(),
                );
            }
            let prompt = "Prompt Copilot native paste test — do not send.";
            let replacement = replacement_target(&composer)?;
            let sequence = controller.copy_to_clipboard(prompt, hwnd)?;
            assert!(crate::selection_capture::matching_text_sequence(
                hwnd.0 as isize,
                "different synthetic text"
            )
            .is_none());
            assert!(controller
                .paste_prompt(
                    hwnd,
                    &composer,
                    sequence.wrapping_sub(1),
                    "different synthetic text",
                    &replacement
                )
                .is_err());
            assert!(read_composer_text(&composer)?.is_empty());
            controller.paste_prompt(hwnd, &composer, sequence, prompt, &replacement)?;
            controller.verify_paste(hwnd, &composer, prompt)?;
            if read_composer_text(&composer)? != prompt {
                return Err("Draft changed after verification; no submission attempted".into());
            }
            eprintln!("Native focus/copy/paste/verification passed. Synthetic draft left unsent for cleanup.");
            Ok::<(), String>(())
        })();
        unsafe { CoUninitialize() };
        result.unwrap();
    }

    #[test]
    fn only_a_marked_single_placeholder_paragraph_is_empty() {
        use super::{has_class, is_placeholder_paragraph, placeholder_text_matches};
        assert!(has_class("ProseMirror ProseMirror-focused", "ProseMirror"));
        assert!(has_class("ProseMirror", "ProseMirror"));
        assert!(!has_class("not-ProseMirror", "ProseMirror"));
        assert!(placeholder_text_matches(
            "Work with ChatGPT\n",
            "Work with ChatGPT"
        ));
        assert!(placeholder_text_matches(
            "Work with ChatGPT\r\n",
            "Work with ChatGPT"
        ));
        assert!(!placeholder_text_matches(
            "Work with ChatGPT\nreal draft",
            "Work with ChatGPT"
        ));
        assert!(!placeholder_text_matches(
            "Work with ChatGPT\n\n",
            "Work with ChatGPT"
        ));
        assert!(!placeholder_text_matches(
            " Work with ChatGPT\n",
            "Work with ChatGPT"
        ));
        assert!(!placeholder_text_matches("", ""));
        assert!(is_placeholder_paragraph("placeholder", true));
        assert!(!is_placeholder_paragraph("", true));
        assert!(!is_placeholder_paragraph("placeholder", false));
        assert!(!is_placeholder_paragraph("not-placeholder", true));
    }
}
