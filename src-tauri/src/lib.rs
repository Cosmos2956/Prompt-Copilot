#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod startup;
mod tray;

struct ShortcutStatus(Option<String>);

#[tauri::command]
fn shortcut_status(status: tauri::State<'_, ShortcutStatus>) -> Option<String> {
    status.0.clone()
}

fn toggle_overlay(app: &tauri::AppHandle) -> tauri::Result<()> {
    if NATIVE_INPUT_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    let guard = NativeInputGuard;
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible()? {
            window.hide()?;
        } else {
            let source = selection_capture::foreground_window();
            let owner = window.hwnd()?.0 as isize;
            // Keep the overlay hidden until Ctrl+C and clipboard polling finish.
            // Blocking work must not stall the Windows event loop.
            tauri::async_runtime::spawn(async move {
                let _guard = guard;
                let captured = tauri::async_runtime::spawn_blocking(move || {
                    selection_capture::capture(source, owner)
                })
                .await
                .unwrap_or(None);
                let result = (|| -> tauri::Result<()> {
                    center_on_pointer_monitor(&window)?;
                    window.show()?;
                    center_on_pointer_monitor(&window)?;
                    window.set_focus()?;
                    window.emit("focus-original-prompt", captured)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("failed to show Prompt Copilot: {error}");
                }
            });
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod chatgpt_controller;
mod gemini_transport;
mod openai_transport;
mod secret_store;
#[cfg(target_os = "windows")]
mod selection_capture;

#[cfg(target_os = "windows")]
static NATIVE_INPUT_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
struct NativeInputGuard;

#[cfg(target_os = "windows")]
impl Drop for NativeInputGuard {
    fn drop(&mut self) {
        NATIVE_INPUT_ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn run_prompt_in_chatgpt(window: tauri::WebviewWindow, prompt: String) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Enter an original prompt first.".into());
    }
    if prompt.contains('\0') {
        return Err("Remove null characters from the prompt before sending.".into());
    }
    NATIVE_INPUT_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another keyboard operation is in progress. Try again.".to_string())?;
    let _guard = NativeInputGuard;
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    window.hide().map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Keep input serialized even if the awaiting IPC future is dropped.
        let _guard = _guard;
        chatgpt_controller::ChatGPTDesktopController.run_prompt(&prompt, owner)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if result.is_err() {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    result
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn copy_prompt_to_clipboard(
    window: tauri::WebviewWindow,
    prompt: String,
) -> Result<(), String> {
    NATIVE_INPUT_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another keyboard operation is in progress. Try again.".to_string())?;
    let guard = NativeInputGuard;
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        chatgpt_controller::ChatGPTDesktopController
            .copy_to_clipboard(&prompt, windows::Win32::Foundation::HWND(owner as *mut _))
            .map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn center_on_pointer_monitor(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let cursor = window.cursor_position()?;
    let monitor = window
        .monitor_from_point(cursor.x, cursor.y)?
        .or(window.primary_monitor()?);

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        window.set_position(PhysicalPosition::new(
            work_area.position.x,
            work_area.position.y,
        ))?;
        window.set_size(LogicalSize::new(720.0, 520.0))?;
        let window_size = window.outer_size()?;
        let x = work_area.position.x
            + (i64::from(work_area.size.width).saturating_sub(i64::from(window_size.width)) / 2)
                as i32;
        let y = work_area.position.y
            + (i64::from(work_area.size.height).saturating_sub(i64::from(window_size.height)) / 2)
                as i32;
        window.set_position(PhysicalPosition::new(x, y))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    startup::record_launch_event(if startup::is_startup_launch(std::env::args()) {
        "autostart-launch"
    } else {
        "manual-launch"
    });
    let result = tauri::Builder::default()
        // Reject duplicate launches before any shortcut or window is created.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            startup::record_launch_event("duplicate-launch-received");
            // A sign-in launch must not focus an already running instance either.
            if !startup::is_startup_launch(args) {
                if let Err(error) = tray::show_overlay(app) {
                    eprintln!("failed to reopen Prompt Copilot: {error}");
                }
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().app_name(startup::STARTUP_NAME).args([startup::STARTUP_ARG]).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(tray::SettingsRequest::default())
        .invoke_handler(tauri::generate_handler![
            run_prompt_in_chatgpt, copy_prompt_to_clipboard, shortcut_status, tray::take_settings_request,
            startup::startup_status, startup::set_startup_enabled,
            secret_store::api_key_configured, secret_store::save_api_key,
            secret_store::remove_api_key, openai_transport::openai_request,
            secret_store::gemini_api_key_configured, secret_store::save_gemini_api_key,
            secret_store::remove_gemini_api_key, gemini_transport::gemini_request
        ])
        .setup(|app| {
            startup::record_launch_event("setup-started");
            tray::setup(app)?;
            startup::record_launch_event("tray-ready");
            // Native startup owns registration; React remounts never register it again.
            let registration = app.global_shortcut().on_shortcut(
                "Ctrl+Shift+Space",
                |app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        startup::record_launch_event("shortcut-pressed");
                        if let Err(error) = toggle_overlay(app) {
                            eprintln!("failed to toggle Prompt Copilot: {error}");
                        }
                    }
                },
            );
            let shortcut_error = registration.err().map(|error| {
                startup::record_launch_event("shortcut-registration-failed");
                eprintln!("failed to register Ctrl+Shift+Space: {error}");
                "Ctrl+Shift+Space is unavailable. Another app or Prompt Copilot instance may be using it. Close that app and restart Prompt Copilot.".to_string()
            });
            if shortcut_error.is_none() {
                startup::record_launch_event("shortcut-ready");
            }
            app.manage(ShortcutStatus(shortcut_error));
            if !startup::is_startup_launch(std::env::args()) {
                tray::show_overlay(app.handle())?;
            }
            startup::record_launch_event("setup-complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("failed to hide Prompt Copilot: {error}");
                }
            }
        })
        .run(tauri::generate_context!());
    startup::record_launch_event(if result.is_ok() {
        "normal-exit"
    } else {
        "application-error"
    });
    result.expect("error while running Prompt Copilot");
}
