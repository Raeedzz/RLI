//! Gemini Flash-Lite client + Gemini Embedding client.
//!
//! All in-app AI in RLI flows through this module:
//!   - commit message generation (Task #8)
//!   - highlight-and-ask answers (Task #7)
//!   - session naming + tab summaries (Task #13)
//!   - memory layer embeddings (Task #12)
//!
//! API key storage: a plain file under
//! `~/Library/Application Support/RLI/gemini-key` with mode 0600. The
//! Touch-ID / Keychain path was retired because:
//!   - dev / ad-hoc-signed builds re-trigger the keychain ACL prompt
//!     every rebuild, surfacing as the "enter your password" dialog
//!     even though we never ask for one;
//!   - the in-process cache resets every app launch, so the first
//!     Gemini call after launch always prompted Touch ID — and if
//!     that first call was "generate commit message" the user
//!     experienced friction on top of friction;
//!   - the Gemini API key is a Google-issued, user-revocable token,
//!     not a high-value secret. App-data-dir storage at 0600 is
//!     proportional to its sensitivity.
//! On launch we still try to migrate any existing keychain entry to
//! the file (silently) so existing users don't have to re-enter their
//! key — see `try_migrate_keychain_to_file`.
//!
//! v1 is non-streaming: one `gemini_generate` call returns full text
//! when ready. Latency on Flash-Lite for 50–200-token outputs is
//! sub-second; if highlight-and-ask ever feels laggy we'll add a
//! streaming variant.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

const FLASH_LITE_MODEL: &str = "gemini-3.1-flash-lite-preview";
const EMBED_MODEL: &str = "text-embedding-004";
const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

const KEYRING_SERVICE: &str = "dev.raeedz.rli";
const KEYRING_USER: &str = "gemini-api-key";

// Without a timeout, a stalled connection (Wi-Fi handoff, captive portal,
// API outage) blocks the call indefinitely — the highlight-and-ask card,
// the AI commit-message button, and the embeddings layer all sit on this
// path. 30s is generous for Flash-Lite (typically <2s) but short enough
// that a clear error surfaces before the user gives up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("reqwest client init"),
        }
    }
}

/// Map a non-success Gemini HTTP response to a user-facing message that
/// the frontend can display verbatim. AskCard.tsx pattern-matches on
/// "api key" / "not configured" to switch into "set API key" mode, so
/// keep those phrases for 401/403.
fn classify_http_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 | 403 => format!("gemini api key rejected (status {status}): {}", body.trim()),
        429 => "gemini rate limited — wait a moment and try again".into(),
        500..=599 => format!("gemini upstream error (status {status})"),
        _ => format!("gemini {status}: {body}"),
    }
}

/* ------------------------------------------------------------------
   Key management
   ------------------------------------------------------------------ */

/// Resolve the on-disk path where we keep the API key. Returns None
/// when we can't figure out a home directory (rare on macOS but the
/// caller still needs to handle it gracefully).
fn key_file_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join("Library")
            .join("Application Support")
            .join("RLI")
            .join("gemini-key"),
    )
}

fn load_key_from_file() -> Option<String> {
    let path = key_file_path()?;
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

fn save_key_to_file(value: &str) -> Result<(), String> {
    let path = key_file_path().ok_or("could not resolve home directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    }
    fs::write(&path, value.trim()).map_err(|e| format!("write key file: {e}"))?;
    // 0600: owner-only read/write. Matches the ssh-key convention so
    // tools that grep for sensitive files (e.g. dotfile audits) treat
    // it appropriately.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn delete_key_file() -> Result<(), String> {
    let Some(path) = key_file_path() else { return Ok(()) };
    match fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove key file: {e}")),
    }
}

/// Prefer the file. On macOS, fall back to the keychain ONLY for users
/// upgrading from the Touch-ID era — and if we successfully read it,
/// migrate by writing it to the file so subsequent reads skip Touch ID.
#[cfg(target_os = "macos")]
fn load_key_for_use() -> Option<String> {
    if let Some(k) = load_key_from_file() {
        return Some(k);
    }
    // Legacy keychain read. This path triggers Touch ID exactly once
    // (during migration). After that the file path takes over.
    let from_keychain =
        crate::keychain::load(KEYRING_SERVICE, KEYRING_USER)
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())?;
    let _ = save_key_to_file(&from_keychain);
    let _ = crate::keychain::delete(KEYRING_SERVICE, KEYRING_USER);
    Some(from_keychain)
}

#[cfg(not(target_os = "macos"))]
fn load_key_for_use() -> Option<String> {
    if let Some(k) = load_key_from_file() {
        return Some(k);
    }
    // Linux/Windows: also honor the env var as a final fallback so the
    // dev workflow without a settings dialog still works.
    std::env::var("GEMINI_API_KEY").ok().filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn gemini_set_key(state: State<GeminiState>, key: String) -> Result<(), String> {
    let trimmed = key.trim().to_owned();
    if trimmed.is_empty() {
        return Err("API key is empty".into());
    }
    save_key_to_file(&trimmed)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    *inner = Some(Client::new(trimmed));
    Ok(())
}

#[tauri::command]
pub fn gemini_clear_key(state: State<GeminiState>) -> Result<(), String> {
    delete_key_file()?;
    // Best-effort keychain cleanup for users with legacy entries.
    #[cfg(target_os = "macos")]
    {
        let _ = crate::keychain::delete(KEYRING_SERVICE, KEYRING_USER);
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
    // Fallback: check storage directly (and warm up the cache while
    // at it). The file path never prompts; the legacy keychain path
    // triggers Touch ID once during migration.
    if let Some(key) = load_key_for_use() {
        if let Ok(mut inner) = state.inner.lock() {
            *inner = Some(Client::new(key));
        }
        return true;
    }
    false
}

fn ensure_client(state: &State<GeminiState>) -> Result<Client, String> {
    ensure_client_with_loader(&state.inner, load_key_for_use)
}

/// Called once during Tauri setup (lib.rs) to populate the in-memory
/// client from the on-disk key file BEFORE the user does anything. No
/// keychain, no Touch ID, no password — just a file read. After this,
/// every gemini call within the app run is a cache hit.
pub fn warm_cache_from_disk(state: &State<GeminiState>) {
    if let Some(key) = load_key_from_file() {
        if let Ok(mut inner) = state.inner.lock() {
            *inner = Some(Client::new(key));
        }
    }
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
    generate_text(
        &state,
        &args.prompt,
        args.system.as_deref(),
        args.max_tokens,
        args.temperature,
    )
    .await
}

/// Reusable Flash-Lite generate. Same wire shape as `gemini_generate`
/// but callable from non-Tauri-command Rust code (e.g. the memory
/// daemon's `/memory/extract` route, which builds prompts internally).
pub async fn generate_text(
    state: &State<'_, GeminiState>,
    prompt: &str,
    system: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let client = ensure_client(state)?;

    let url = format!(
        "{API_BASE}/models/{FLASH_LITE_MODEL}:generateContent?key={}",
        client.api_key
    );

    let body = GenerateRequest {
        contents: vec![RequestContent {
            parts: vec![RequestPart { text: prompt }],
            role: Some("user"),
        }],
        system_instruction: system.map(|s| RequestContent {
            parts: vec![RequestPart { text: s }],
            role: None,
        }),
        generation_config: Some(GenerationConfig {
            temperature,
            max_output_tokens: max_tokens,
        }),
    };

    let res = client
        .http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "gemini request timed out — check your connection".to_string()
            } else {
                e.to_string()
            }
        })?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(classify_http_error(status, &text));
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
        .map_err(|e| {
            if e.is_timeout() {
                "gemini embed timed out — check your connection".to_string()
            } else {
                e.to_string()
            }
        })?;

    let status = res.status();
    let body_text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(classify_http_error(status, &body_text));
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

    /* ---------- HTTP error classification ----------
       AskCard.tsx (frontend) toggles into "set API key" mode by
       matching "api key" or "not configured" case-insensitively, so
       401/403 paths must contain "api key". */

    #[test]
    fn http_401_mentions_api_key() {
        let msg = classify_http_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"API key not valid"}}"#,
        );
        assert!(
            msg.to_lowercase().contains("api key"),
            "401 must contain 'api key' for frontend re-auth flow, got: {msg}"
        );
    }

    #[test]
    fn http_403_mentions_api_key() {
        let msg = classify_http_error(reqwest::StatusCode::FORBIDDEN, "permission denied");
        assert!(msg.to_lowercase().contains("api key"));
    }

    #[test]
    fn http_429_says_rate_limited_without_dumping_body() {
        // Rate-limit responses can be huge JSON; the user just needs the gist.
        let msg = classify_http_error(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"message":"Quota exceeded","details":[/* lots */]}}"#,
        );
        assert!(msg.to_lowercase().contains("rate limit"));
        assert!(
            !msg.contains("Quota"),
            "429 message should not regurgitate the response body, got: {msg}"
        );
    }

    #[test]
    fn http_500_does_not_leak_response_body() {
        // 5xx bodies are almost always upstream HTML/stack traces — useless to
        // the user and noisy in the UI. Status code is enough.
        let msg = classify_http_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "<html>nginx 502</html>",
        );
        assert!(msg.contains("upstream"));
        assert!(!msg.contains("nginx"));
    }

    #[test]
    fn http_other_4xx_passes_through() {
        // Catch-all for unexpected statuses — surface body so we can debug.
        let msg = classify_http_error(reqwest::StatusCode::BAD_REQUEST, "bad payload");
        assert!(msg.contains("400"));
        assert!(msg.contains("bad payload"));
    }
}
