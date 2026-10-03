//! The only persistent secret store. No command returns stored key material.
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::ERROR_NOT_FOUND,
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    },
};
use zeroize::{Zeroize, Zeroizing};

pub const OPENAI_TARGET: &str = "com.promptcopilot.desktop/openai-api-key";
pub const GEMINI_TARGET: &str = "com.promptcopilot.desktop/gemini_api_key";
pub const MISSING_GEMINI_KEY: &str =
    "Add your Gemini API key in Settings before using prompt optimization.";
pub const MISSING_KEY: &str = "Add your API key in Settings before using prompt optimization.";
const READ_ERROR: &str =
    "Windows Credential Manager could not read your API key. Try again or check Settings.";

pub struct SecretStore<'a> {
    target: &'a str,
}

impl<'a> SecretStore<'a> {
    pub fn new(target: &'a str) -> Self {
        Self { target }
    }

    pub fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        let target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        let mut credential = std::ptr::null_mut();
        unsafe {
            if let Err(error) = CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            ) {
                return if error.code() == ERROR_NOT_FOUND.to_hresult() {
                    Ok(None)
                } else {
                    Err(READ_ERROR.into())
                };
            }
            let stored = &*credential;
            let result = if stored.CredentialBlobSize == 0 || stored.CredentialBlob.is_null() {
                Err(READ_ERROR.into())
            } else {
                let bytes = std::slice::from_raw_parts_mut(
                    stored.CredentialBlob,
                    stored.CredentialBlobSize as usize,
                );
                let value = std::str::from_utf8(bytes)
                    .map(|value| Zeroizing::new(value.to_owned()))
                    .map_err(|_| READ_ERROR.to_string());
                bytes.zeroize();
                value.and_then(|value| {
                    validate_key(&value).map_err(|_| READ_ERROR.to_string())?;
                    Ok(Some(value))
                })
            };
            CredFree(credential.cast());
            result
        }
    }

    pub fn save(&self, input: &str) -> Result<(), String> {
        let key = validate_key(input)?;
        let mut bytes = Zeroizing::new(key.as_bytes().to_vec());
        let mut target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        let mut username: Vec<u16> = "Prompt Copilot".encode_utf16().chain(Some(0)).collect();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            UserName: PWSTR(username.as_mut_ptr()),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            // Persists for this Windows user across sign-outs and restarts, without roaming.
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }
            .map_err(|_| "Windows Credential Manager could not save the key. Your previous key has not been replaced.".into())
    }

    pub fn remove(&self) -> Result<(), String> {
        let target: Vec<u16> = self.target.encode_utf16().chain(Some(0)).collect();
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
            Err(_) => Err("Windows Credential Manager could not remove the key. Try again.".into()),
        }
    }
}

fn validate_key(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Enter an API key before saving.".into());
    }
    if value.len() > 2560 || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("The API key must contain only printable characters without spaces and be at most 2560 characters.".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn api_key_configured() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        SecretStore::new(OPENAI_TARGET)
            .read()
            .map(|key| key.is_some())
    })
    .await
    .map_err(|_| READ_ERROR.to_string())?
}

#[tauri::command]
pub async fn save_api_key(key: String) -> Result<(), String> {
    let key = Zeroizing::new(key);
    tauri::async_runtime::spawn_blocking(move || SecretStore::new(OPENAI_TARGET).save(&key))
        .await
        .map_err(|_| "Could not save the API key. Try again.".to_string())?
}

#[tauri::command]
pub async fn remove_api_key() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| SecretStore::new(OPENAI_TARGET).remove())
        .await
        .map_err(|_| "Could not remove the API key. Try again.".to_string())?
}

#[tauri::command]
pub async fn gemini_api_key_configured() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        SecretStore::new(GEMINI_TARGET)
            .read()
            .map(|key| key.is_some())
    })
    .await
    .map_err(|_| READ_ERROR.to_string())?
}

#[tauri::command]
pub async fn save_gemini_api_key(key: String) -> Result<(), String> {
    let key = Zeroizing::new(key);
    tauri::async_runtime::spawn_blocking(move || SecretStore::new(GEMINI_TARGET).save(&key))
        .await
        .map_err(|_| "Could not save the Gemini API key. Try again.".to_string())?
}

#[tauri::command]
pub async fn remove_gemini_api_key() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| SecretStore::new(GEMINI_TARGET).remove())
        .await
        .map_err(|_| "Could not remove the Gemini API key. Try again.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_without_echoing_secrets() {
        assert!(validate_key("  test-key  ").is_ok_and(|key| key == "test-key"));
        for invalid in ["", "  ", "test\nkey", "test\0key"] {
            assert!(validate_key(invalid).is_err());
        }
        assert!(validate_key(&"x".repeat(2561)).is_err());
    }

    #[test]
    #[ignore = "writes only an isolated synthetic test credential to Windows Credential Manager"]
    fn credential_lifecycle() {
        let target = format!("com.promptcopilot.test/{}", std::process::id());
        let store = SecretStore::new(&target);
        assert!(store.read().unwrap().is_none());
        struct Cleanup<'a>(SecretStore<'a>);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.remove();
            }
        }
        let _cleanup = Cleanup(SecretStore::new(&target));
        store.save("  synthetic-first  ").unwrap();
        assert!(store
            .read()
            .unwrap()
            .is_some_and(|key| key.as_str() == "synthetic-first"));
        store.save("synthetic-replaced").unwrap();
        assert!(store
            .read()
            .unwrap()
            .is_some_and(|key| key.as_str() == "synthetic-replaced"));
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "secret_store::tests::read_after_process_restart",
                "--ignored",
            ])
            .env("PROMPT_COPILOT_TEST_CREDENTIAL_TARGET", &target)
            .status()
            .unwrap();
        assert!(child.success());
        store.remove().unwrap();
        assert!(store.read().unwrap().is_none());
    }

    #[test]
    #[ignore = "run by credential_lifecycle in a separate process"]
    fn read_after_process_restart() {
        let target = std::env::var("PROMPT_COPILOT_TEST_CREDENTIAL_TARGET").unwrap();
        assert!(target.starts_with("com.promptcopilot.test/"));
        assert!(SecretStore::new(&target)
            .read()
            .unwrap()
            .is_some_and(|key| key.as_str() == "synthetic-replaced"));
    }
}
