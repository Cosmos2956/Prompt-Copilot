//! Best-effort selected-text capture. Never focus another window or clear the
//! clipboard to detect a copy: the sequence number distinguishes stale content.
use std::{
    mem::size_of,
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
            GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
    },
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            VK_SPACE,
        },
        WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(15);
const KEY_RELEASE_TIMEOUT: Duration = Duration::from_millis(800);
const COPY_TIMEOUT: Duration = Duration::from_millis(450);
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

struct Clipboard;
impl Clipboard {
    fn open(owner: HWND) -> Option<Self> {
        unsafe {
            OpenClipboard(Some(owner)).ok()?;
        }
        Some(Self)
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

// Caller holds the clipboard open. Bound reads by the actual allocation.
fn read_text() -> Option<String> {
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        if !(2..=MAX_TEXT_BYTES).contains(&size) || size % 2 != 0 {
            return None;
        }
        let pointer = GlobalLock(memory) as *const u16;
        if pointer.is_null() {
            return None;
        }
        let units = std::slice::from_raw_parts(pointer, size / 2);
        let result = decode_text(units);
        let _ = GlobalUnlock(memory);
        result
    }
}

// Verify text under the clipboard lock before accepting a sequence change.
// Closing the clipboard can add Windows text formats without changing its text.
pub(crate) fn matching_text_sequence(owner: isize, expected: &str) -> Option<u32> {
    let _clipboard = Clipboard::open(HWND(owner as *mut _))?;
    if read_text()?.as_str() != expected {
        return None;
    }
    let sequence = unsafe { GetClipboardSequenceNumber() };
    (sequence != 0).then_some(sequence)
}

fn decode_text(units: &[u16]) -> Option<String> {
    let end = units.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&units[..end]).ok()
}

fn plain_text_only() -> bool {
    let mut format = 0;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            return true;
        }
        // Windows may synthesize ANSI/OEM text and locale from Unicode text.
        if !matches!(format, 1 | 7 | 13 | 16) {
            return false;
        }
    }
}

fn process_id(window: HWND) -> u32 {
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut pid));
    }
    pid
}

fn keyboard_input(key: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    }
}

fn send_copy() -> bool {
    let inputs = [
        keyboard_input(VK_CONTROL, false),
        keyboard_input(VK_C, false),
        keyboard_input(VK_C, true),
        keyboard_input(VK_CONTROL, true),
    ];
    if unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) } == inputs.len() as u32 {
        return true;
    }
    // Release only the keys this operation injected after a partial send.
    unsafe {
        SendInput(
            &[keyboard_input(VK_C, true), keyboard_input(VK_CONTROL, true)],
            size_of::<INPUT>() as i32,
        );
    }
    false
}

fn restore_text(owner: HWND, expected_sequence: u32, text: &str) {
    let Some(_clipboard) = Clipboard::open(owner) else {
        return;
    };
    // Never overwrite a newer copy made by the user or another application.
    if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
        return;
    }
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2) else {
            return;
        };
        let pointer = GlobalLock(memory) as *mut u16;
        if pointer.is_null() {
            let _ = GlobalFree(Some(memory));
            return;
        }
        pointer.copy_from_nonoverlapping(units.as_ptr(), units.len());
        let _ = GlobalUnlock(memory);
        if EmptyClipboard().is_err()
            || SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0))).is_err()
        {
            let _ = GlobalFree(Some(memory));
        }
    }
}

pub fn capture(source: isize, owner: isize) -> Option<String> {
    if source == 0 || source == owner {
        return None;
    }
    let source = HWND(source as *mut _);
    let owner = HWND(owner as *mut _);
    let source_pid = process_id(source);
    if source_pid == 0 || source_pid == process_id(owner) {
        return None;
    }
    let deadline = Instant::now() + KEY_RELEASE_TIMEOUT;
    loop {
        if unsafe { GetForegroundWindow() } != source {
            return None;
        }
        let held = [
            VK_CONTROL, VK_SHIFT, VK_SPACE, VK_MENU, VK_LWIN, VK_RWIN, VK_C,
        ]
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0);
        if !held {
            break;
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(POLL_INTERVAL);
    }
    let (previous, baseline) = {
        let _clipboard = Clipboard::open(owner)?;
        let previous = if plain_text_only() { read_text() } else { None };
        (previous, unsafe { GetClipboardSequenceNumber() })
    };
    if baseline == 0 || unsafe { GetForegroundWindow() } != source || !send_copy() {
        return None;
    }
    let deadline = Instant::now() + COPY_TIMEOUT;
    while Instant::now() < deadline {
        if unsafe { GetForegroundWindow() } != source {
            return None;
        }
        if unsafe { GetClipboardSequenceNumber() } != baseline {
            if let Some(clipboard) = Clipboard::open(owner) {
                // Reject unrelated clipboard writers. Some applications delegate
                // copy to another process; those conservatively fall back to manual entry.
                if process_id(unsafe { GetClipboardOwner().ok()? }) != source_pid {
                    return None;
                }
                let text = read_text();
                let sequence = unsafe { GetClipboardSequenceNumber() };
                drop(clipboard);
                if let Some(previous) = previous.as_deref() {
                    restore_text(owner, sequence, previous);
                }
                return text.filter(|text| !text.trim().is_empty());
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::decode_text;
    #[test]
    fn preserves_unicode_and_multiline_text() {
        let text = "हैलो 🌍\r\nSecond line\n  indented";
        let units: Vec<u16> = text.encode_utf16().chain([0, 99]).collect();
        assert_eq!(decode_text(&units).as_deref(), Some(text));
    }
    #[test]
    fn rejects_unterminated_or_invalid_text() {
        assert_eq!(decode_text(&[65]), None);
        assert_eq!(decode_text(&[0xD800, 0]), None);
        assert_eq!(decode_text(&[0]), Some(String::new()));
    }
}
