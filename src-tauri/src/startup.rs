use tauri::{menu::CheckMenuItem, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

pub(crate) const STARTUP_ARG: &str = "--autostart";
pub(crate) const STARTUP_NAME: &str = "Prompt Copilot";
pub(crate) struct StartupMenu(pub CheckMenuItem<tauri::Wry>);

// Local lifecycle diagnostics only: never include prompts, clipboard contents,
// credentials, or provider responses. Keep this small for a background utility.
pub(crate) fn record_launch_event(event: &str) {
    use std::io::Write;
    let Some(local_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = std::path::PathBuf::from(local_data).join("com.promptcopilot.desktop");
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("startup.log");
    let truncate = std::fs::metadata(&path)
        .map(|metadata| metadata.len() >= 64 * 1024)
        .unwrap_or(false);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path)
    else {
        return;
    };
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "{seconds} pid={} {event}", std::process::id());
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct StartupStatus {
    enabled: Option<bool>,
    error: Option<String>,
}

pub(crate) fn is_startup_launch(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == STARTUP_ARG)
}

fn startup_command(executable: &std::path::Path) -> String {
    format!("\"{}\" {STARTUP_ARG}", executable.display())
}

fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
        RegKey,
    };
    let executable = std::env::current_exe().map_err(|_| "Could not locate the application.")?;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_SET_VALUE,
        )
        .map_err(|_| "Could not open Windows startup settings.")?;
    if app.autolaunch().enable().is_err() {
        // The plugin can fail after writing Run but before updating Windows'
        // StartupApproved entry. Remove that partial registration as well.
        let _ = app.autolaunch().disable();
        return Err("Could not enable Windows startup.".into());
    }
    // auto-launch 0.5 writes an unquoted path. Correct the SAME registration so
    // directories containing spaces launch the intended executable reliably.
    if key
        .set_value(STARTUP_NAME, &startup_command(&executable))
        .is_err()
    {
        let _ = app.autolaunch().disable();
        return Err("Could not save the Windows startup command.".into());
    }
    Ok(())
}

// The Windows registration is the persistent source of truth, not a second flag.
#[tauri::command]
pub(crate) fn startup_status(app: tauri::AppHandle) -> StartupStatus {
    let status = match app.autolaunch().is_enabled() {
        Ok(enabled) => StartupStatus {
            enabled: Some(enabled),
            error: None,
        },
        Err(_) => StartupStatus {
            enabled: None,
            error: Some(
                "Could not read the Windows startup setting. Reopen Settings to retry.".into(),
            ),
        },
    };
    if let (Some(enabled), Some(menu)) = (status.enabled, app.try_state::<StartupMenu>()) {
        let _ = menu.0.set_checked(enabled);
    }
    status
}

#[tauri::command]
pub(crate) fn set_startup_enabled(app: tauri::AppHandle, enabled: bool) -> StartupStatus {
    let result = if enabled {
        enable(&app)
    } else {
        app.autolaunch()
            .disable()
            .map_err(|_| "Could not disable Windows startup.".to_string())
    };
    let mut status = startup_status(app.clone());
    if (result.is_err() && (enabled || status.enabled != Some(false)))
        || status.enabled != Some(enabled)
    {
        status.error = Some("Could not change the Windows startup setting. Try again.".into());
    }
    let _ = app.emit("startup-changed", &status);
    status
}

pub(crate) fn toggle(app: &tauri::AppHandle) {
    let status = startup_status(app.clone());
    if let Some(enabled) = status.enabled {
        set_startup_enabled(app.clone(), !enabled);
    } else {
        let _ = app.emit("startup-changed", status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_command_quotes_executable_paths_with_spaces() {
        assert_eq!(
            startup_command(std::path::Path::new(
                r"C:\Users\rishi\Prompt engineering application\prompt-copilot.exe"
            )),
            r#""C:\Users\rishi\Prompt engineering application\prompt-copilot.exe" --autostart"#
        );
    }

    #[test]
    fn only_explicit_startup_argument_hides_launch() {
        assert!(!is_startup_launch(vec!["prompt-copilot.exe".into()]));
        assert!(is_startup_launch(vec![
            "prompt-copilot.exe".into(),
            "--autostart".into()
        ]));
        assert!(!is_startup_launch(vec![
            "prompt-copilot.exe".into(),
            "--autostart=false".into()
        ]));
    }
}
