//! Fixed-host transport. Saved keys and provider error bodies never cross IPC.
use crate::secret_store::{SecretStore, GEMINI_TARGET, MISSING_GEMINI_KEY};
use serde_json::Value;
use std::time::Duration;

#[tauri::command]
pub async fn gemini_request(model: String, body: Value) -> Result<Value, String> {
    // Accept model identifiers only, never paths or user-selected endpoints.
    if !model.starts_with("gemini-")
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err("The Gemini model configuration is invalid.".into());
    }
    let key = tauri::async_runtime::spawn_blocking(|| SecretStore::new(GEMINI_TARGET).read())
        .await
        .map_err(|_| "Could not read the saved Gemini API key. Check Settings.".to_string())??
        .ok_or_else(|| MISSING_GEMINI_KEY.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the secure Gemini connection.".to_string())?;
    let mut authorization = reqwest::header::HeaderValue::from_str(key.as_str())
        .map_err(|_| "The saved Gemini API key is invalid. Replace it in Settings.".to_string())?;
    authorization.set_sensitive(true);
    let response = client
        .post(format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        ))
        .header("x-goog-api-key", authorization)
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    match response.status().as_u16() {
        200..=299 => response.json::<Value>().await.map_err(|error| {
            if error.is_timeout() { network_error(error) }
            else { "Gemini returned a malformed response. Try again.".into() }
        }),
        401 | 403 => Err("Gemini could not authenticate this key. Check its permissions or replace it in Settings.".into()),
        400 => {
            // Inspect only structured error codes; never return messages that may echo secrets.
            let data = response.json::<Value>().await.unwrap_or(Value::Null);
            let invalid_key = data.pointer("/error/details").and_then(Value::as_array)
                .is_some_and(|details| details.iter().any(|detail| detail.get("reason").and_then(Value::as_str) == Some("API_KEY_INVALID")));
            Err(if invalid_key {
                "Gemini API key is invalid. Update it in Settings."
            } else {
                "Gemini rejected the request. Check your API key and model access in Settings."
            }.into())
        },
        429 => Err("Gemini quota or rate limit reached. Try again later.".into()),
        500..=599 => Err("Gemini is temporarily unavailable. Try again later.".into()),
        _ => Err("The Gemini request failed. Check your API key and model access.".into()),
    }
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The Gemini request timed out. Try again."
    } else {
        "Could not connect to Gemini. Check your connection and try again."
    }
    .into()
}
