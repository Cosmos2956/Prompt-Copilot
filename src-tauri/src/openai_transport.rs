//! Fixed-endpoint authenticated transport. Keys and error bodies never cross IPC.
use crate::secret_store::{SecretStore, MISSING_KEY, OPENAI_TARGET};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
pub struct ProviderResponse {
    status: u16,
    data: Option<Value>,
}

#[tauri::command]
pub async fn openai_request(body: Value) -> Result<ProviderResponse, String> {
    let key = tauri::async_runtime::spawn_blocking(|| SecretStore::new(OPENAI_TARGET).read())
        .await
        .map_err(|_| "Could not read the saved API key. Check Settings.".to_string())??
        .ok_or_else(|| MISSING_KEY.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the secure OpenAI connection.".to_string())?;
    let header = zeroize::Zeroizing::new(format!("Bearer {}", key.as_str()));
    let mut authorization = reqwest::header::HeaderValue::from_str(&header)
        .map_err(|_| "The saved API key is invalid. Replace it in Settings.".to_string())?;
    authorization.set_sensitive(true);
    let response = client
        .post("https://api.openai.com/v1/responses")
        .header(reqwest::header::AUTHORIZATION, authorization)
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status().as_u16();
    // Never return raw provider error bodies: authentication errors may echo key fragments.
    let data = if response.status().is_success() {
        Some(response.json::<Value>().await.map_err(|error| {
            if error.is_timeout() {
                network_error(error)
            } else {
                "OpenAI returned an invalid response.".to_string()
            }
        })?)
    } else {
        None
    };
    Ok(ProviderResponse { status, data })
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The OpenAI request timed out. Try again."
    } else {
        "Could not connect to OpenAI. Check your connection and try again."
    }
    .into()
}
