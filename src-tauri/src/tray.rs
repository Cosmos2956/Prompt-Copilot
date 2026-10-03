use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const TRAY_ID: &str = "prompt-copilot-tray";

#[derive(Default)]
pub(crate) struct SettingsRequest(AtomicBool);

#[tauri::command]
pub(crate) fn take_settings_request(request: tauri::State<'_, SettingsRequest>) -> bool {
    request.0.swap(false, Ordering::AcqRel)
}

// Tray and duplicate-launch activation must never capture text or toggle closed.
pub(crate) fn show_overlay(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible()? {
            super::center_on_pointer_monitor(&window)?;
            window.show()?;
            super::center_on_pointer_monitor(&window)?;
        }
        window.set_focus()?;
    }
    Ok(())
}

pub(crate) fn setup(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Prompt Copilot", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let startup = CheckMenuItem::with_id(
        app,
        "startup",
        "Start with Windows",
        true,
        false,
        None::<&str>,
    )?;
    app.manage(super::startup::StartupMenu(startup.clone()));
    super::startup::startup_status(app.handle().clone());
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &startup, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("application icon missing")
                .clone(),
        )
        .tooltip("Prompt Copilot")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "startup" => super::startup::toggle(app),
            "open" => {
                if let Err(error) = show_overlay(app) {
                    eprintln!("failed to open Prompt Copilot: {error}");
                }
            }
            "settings" => {
                // Keep the request until React receives it, including during startup.
                app.state::<SettingsRequest>()
                    .0
                    .store(true, Ordering::Release);
                if let Err(error) = show_overlay(app).and_then(|()| {
                    app.get_webview_window("main")
                        .expect("main window missing")
                        .emit("open-settings", ())
                }) {
                    eprintln!("failed to open Settings: {error}");
                }
            }
            "quit" => {
                if let Err(error) = app.global_shortcut().unregister_all() {
                    eprintln!("failed to unregister global shortcut: {error}");
                }
                drop(app.remove_tray_by_id(TRAY_ID));
                // Tauri's normal exit releases windows, plugins and native resources.
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
