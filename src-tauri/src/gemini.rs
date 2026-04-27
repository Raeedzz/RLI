//! Gemini Flash-Lite client + Gemini Embedding client.
//!
//! All in-app AI in RLI flows through this module:
//!   - commit message generation (Task #8)
//!   - highlight-and-ask answers (Task #7)
//!   - session naming + tab summaries (Task #13)
//!   - memory layer embeddings (Task #12)
//!
//! API key is stored in the macOS Keychain via the `keyring` crate.
//! No proxy server, no SDK bloat — just `reqwest` against the public
//! `generativelanguage.googleapis.com` endpoint.
//!
//! v1 is non-streaming: one `gemini_generate` call returns full text
//! when ready. Latency on Flash-Lite for 50–200-token outputs is
//! sub-second; if highlight-and-ask ever feels laggy we'll add a
//! streaming variant.

use std::sync::Mutex;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::State;

const FLASH_LITE_MODEL: &str = "gemini-3.1-flash-lite-preview";
const EMBED_MODEL: &str = "text-embedding-004";
const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

const KEYRING_SERVICE: &str = "dev.raeedz.rli";
const KEYRING_USER: &str = "gemini-api-key";

#[derive(Default)]
pub struct GeminiState {
    inner: Mutex<Option<Client>>,
}

struct Client {
    api_key: String,
    http: reqwest::Client,
}

impl Client {
    fn new(api_key: String) -> Self {
        Self {
            api_key,
            http: reqwest::Client::builder()
                .user_agent("rli/0.0.1")
                .build()
                .expect("reqwest client init"),
        }
    }
}

/* ------------------------------------------------------------------
   Key management
   ------------------------------------------------------------------ */

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn load_key_from_keychain() -> Option<String> {
    keyring_entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn gemini_set_key(state: State<GeminiState>, key: String) -> Result<(), String> {
    let trimmed = key.trim().to_owned();
    if trimmed.is_empty() {
        return Err("API key is empty".into());
    }
    keyring_entry()?
        .set_password(&trimmed)
        .map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    *inner = Some(Client::new(trimmed));
    Ok(())
}

#[tauri::command]
pub fn gemini_clear_key(state: State<GeminiState>) -> Result<(), String> {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    *inner = None;
    Ok(())
}

#[tauri::command]
pub fn gemini_key_status(state: State<GeminiState>) -> bool {
    {
        let inner = state.inner.lock().ok();
        if let Some(g) = inner.as_ref().and_then(|m| m.as_ref()) {
            if !g.api_key.is_empty() {
                return true;
            }
        }
    }
    // Fallback: check keychain directly (and warm up the cache while at it)
    if let Some(key) = load_key_from_keychain() {
        if let Ok(mut inner) = state.inner.lock() {
            *inner = Some(Client::new(key));
        }
        return true;
    }
    false
}

fn ensure_client(state: &State<GeminiState>) -> Result<Client, String> {
    ensure_client_with_loader(&state.inner, load_key_from_keychain)
}

fn ensure_client_with_loader(
    inner: &Mutex<Option<Client>>,
    loader: impl FnOnce() -> Option<String>,
) -> Result<Client, String> {
    {
        let guard = inner.lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.as_ref() {
            return Ok(Client {
                api_key: c.api_key.clone(),
                http: c.http.clone(),
            });
        }
    }
    let key = loader().ok_or("Gemini API key not configured")?;
    let client = Client::new(key);
    let cloned = Client {
        api_key: client.api_key.clone(),
        http: client.http.clone(),
    };
    if let Ok(mut guard) = inner.lock() {
        *guard = Some(client);
    }
    Ok(cloned)
}

/* ------------------------------------------------------------------
   Generate
   ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct GenerateArgs {
    pub prompt: String,
    pub system: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Serialize)]
struct GenerateRequest<'a> {
    contents: Vec<RequestContent<'a>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "systemInstruction")]
    system_instruction: Option<RequestContent<'a>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "generationConfig")]
    generation_config: Option<GenerationConfig>,
}

#[derive(Serialize)]
struct RequestContent<'a> {
    parts: Vec<RequestPart<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
}

#[derive(Serialize)]
struct RequestPart<'a> {
    text: &'a str,
}

#[derive(Serialize, Default)]
struct GenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "maxOutputTokens")]
    max_output_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct GenerateResponse {
    candidates: Option<Vec<Candidate>>,
    #[serde(rename = "promptFeedback")]
    prompt_feedback: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Candidate {
    content: Option<RespContent>,
}

#[derive(Deserialize)]
struct RespContent {
    parts: Option<Vec<RespPart>>,
}

#[derive(Deserialize)]
struct RespPart {
    text: Option<String>,
}

#[tauri::command]
pub async fn gemini_generate(
    state: State<'_, GeminiState>,
    args: GenerateArgs,
) -> Result<String, String> {
    let client = ensure_client(&state)?;

    let url = format!(
        "{API_BASE}/models/{FLASH_LITE_MODEL}:generateContent?key={}",
        client.api_key
    );

    let body = GenerateRequest {
        contents: vec![RequestContent {
            parts: vec![RequestPart { text: &args.prompt }],
            role: Some("user"),
        }],
        system_instruction: args.system.as_deref().map(|s| RequestContent {
            parts: vec![RequestPart { text: s }],
            role: None,
        }),
        generation_config: Some(GenerationConfig {
            temperature: args.temperature,
            max_output_tokens: args.max_tokens,
        }),
    };

    let res = client
        .http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("gemini {status}: {text}"));
    }

    let parsed: GenerateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("parse gemini response: {e} :: {text}"))?;
    let out = parsed
        .candidates
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.content)
        .and_then(|c| c.parts)
        .and_then(|p| p.into_iter().next())
        .and_then(|p| p.text)
        .ok_or_else(|| {
            format!(
                "gemini returned no text (feedback: {:?})",
                parsed.prompt_feedback
            )
        })?;

    Ok(out)
}

/* ------------------------------------------------------------------
   Embed
   ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct EmbedResponse {
    embedding: Embedding,
}

#[derive(Deserialize)]
struct Embedding {
    values: Vec<f32>,
}

#[tauri::command]
pub async fn gemini_embed(
    state: State<'_, GeminiState>,
    text: String,
) -> Result<Vec<f32>, String> {
    let client = ensure_client(&state)?;

    let url = format!(
        "{API_BASE}/models/{EMBED_MODEL}:embedContent?key={}",
        client.api_key
    );

    let model_path = format!("models/{EMBED_MODEL}");
    let body = serde_json::json!({
        "model": model_path,
        "content": {
            "parts": [{ "text": text }]
        }
    });

    let res = client
        .http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let body_text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("gemini embed {status}: {body_text}"));
    }

    let parsed: EmbedResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("parse embed response: {e}"))?;
    Ok(parsed.embedding.values)
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn missing_key_returns_clear_error_message() {
        let inner: Mutex<Option<Client>> = Mutex::new(None);
        let err = match ensure_client_with_loader(&inner, || None) {
            Err(e) => e,
            Ok(_) => panic!("expected error when no key"),
        };
        let lower = err.to_lowercase();
        // AskCard.tsx (frontend) toggles into "set API key" mode by matching
        // either of these substrings case-insensitively. Pin that contract.
        assert!(
            lower.contains("api key") || lower.contains("not configured"),
            "error must contain 'api key' or 'not configured' for frontend matching, got: {err}"
        );
    }

    #[test]
    fn missing_key_does_not_populate_cache() {
        let inner: Mutex<Option<Client>> = Mutex::new(None);
        let _ = ensure_client_with_loader(&inner, || None);
        assert!(inner.lock().unwrap().is_none());
    }

    #[test]
    fn cached_client_is_returned_without_invoking_loader() {
        let inner: Mutex<Option<Client>> = Mutex::new(Some(Client::new("cached-key".into())));
        let loader_called = AtomicBool::new(false);
        let client = match ensure_client_with_loader(&inner, || {
            loader_called.store(true, Ordering::SeqCst);
            Some("loader-key".into())
        }) {
            Ok(c) => c,
            Err(e) => panic!("cache hit should succeed: {e}"),
        };
        assert_eq!(client.api_key, "cached-key");
        assert!(
            !loader_called.load(Ordering::SeqCst),
            "loader must not be called when cache is hit"
        );
    }

    #[test]
    fn loader_key_is_used_and_cached_on_miss() {
        let inner: Mutex<Option<Client>> = Mutex::new(None);
        let client = match ensure_client_with_loader(&inner, || Some("fresh-key".into())) {
            Ok(c) => c,
            Err(e) => panic!("loader-provided key should succeed: {e}"),
        };
        assert_eq!(client.api_key, "fresh-key");
        // Cache should now hold the new client
        let guard = inner.lock().unwrap();
        assert_eq!(guard.as_ref().unwrap().api_key, "fresh-key");
    }
}
