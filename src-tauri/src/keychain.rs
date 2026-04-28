//! Touch ID-gated wrapper around the macOS Keychain for the Gemini key.
//!
//! Why we don't set `kSecAttrAccessControl` on the keychain item: that
//! routes through the data-protection keychain, which requires the
//! bundle to be signed with `keychain-access-groups` and a stable Team
//! ID. Dev / ad-hoc-signed Tauri builds get `errSecMissingEntitlement`
//! (OSStatus -34018) the moment they try to write such an item.
//!
//! What we do instead: store the secret as a plain generic password
//! (via the `keyring` crate, no ACL) and prompt the user for Touch ID
//! through `LAContext` from `LocalAuthentication.framework` before
//! every read / write / delete. The system surface is identical to
//! ACL-protected reads (Touch ID prompt, passcode fallback) but works
//! without entitlements.
//!
//! All entries are macOS-only and gated behind `cfg(target_os =
//! "macos")` at the call site (gemini.rs).

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::sync::{mpsc, OnceLock, RwLock};
use std::time::Duration;

use block2::RcBlock;
use keyring::Entry;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};

/// Per-process cache of successfully unlocked secrets, keyed by
/// `(service, account)`. Once the user authenticates with Touch ID /
/// passcode for a given entry, we hold the secret in memory for the
/// rest of the run so they don't re-authenticate on every read.
///
/// Cleared by `delete()` when the user explicitly removes the key.
/// Overwritten by `save_with_biometry()` so a key change is reflected
/// immediately. The cache is process-scoped — quitting the app drops
/// it, and the next launch's first read re-prompts (which is the
/// Touch ID UX we want for security).
fn session_cache() -> &'static RwLock<HashMap<(String, String), String>> {
    static CACHE: OnceLock<RwLock<HashMap<(String, String), String>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn cache_get(service: &str, account: &str) -> Option<String> {
    session_cache()
        .read()
        .ok()?
        .get(&(service.to_string(), account.to_string()))
        .cloned()
}

fn cache_put(service: &str, account: &str, value: String) {
    if let Ok(mut guard) = session_cache().write() {
        guard.insert((service.to_string(), account.to_string()), value);
    }
}

fn cache_drop(service: &str, account: &str) {
    if let Ok(mut guard) = session_cache().write() {
        guard.remove(&(service.to_string(), account.to_string()));
    }
}

/// Maximum time we wait for the Touch ID dialog before giving up. Real
/// users answer in well under 60s — anything past that is almost
/// certainly a stuck session and we shouldn't block the app indefinitely.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Show a Touch ID prompt with the given reason text. Falls back to the
/// device passcode automatically if biometry isn't available (LAPolicy
/// `DeviceOwnerAuthentication`). Returns Ok on success, Err with a
/// human-readable message on cancel / failure / timeout.
fn prompt_biometry(reason: &str) -> Result<(), String> {
    let context: Retained<LAContext> = unsafe { LAContext::new() };
    let ns_reason = NSString::from_str(reason);

    // The completion handler runs on a dispatch queue chosen by
    // LocalAuthentication, so we marshal the result back to the caller
    // through a channel. `RcBlock` keeps the callback alive until the
    // reply fires.
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tx_clone = tx.clone();
    let block = RcBlock::new(move |success: Bool, error: *mut NSError| {
        let result = if success.as_bool() {
            Ok(())
        } else if let Some(err) = unsafe { error.as_ref() } {
            // -2 is LAErrorUserCancel, -4 is LAErrorSystemCancel — both
            // get the same "cancelled" treatment.
            let code = err.code();
            let msg = err.localizedDescription().to_string();
            if code == -2 || code == -4 {
                Err("biometric prompt cancelled".to_string())
            } else {
                Err(format!("biometric auth failed: {msg} (code {code})"))
            }
        } else {
            Err("biometric auth failed".to_string())
        };
        let _ = tx_clone.send(result);
    });

    unsafe {
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &ns_reason,
            &block,
        );
    }

    match rx.recv_timeout(PROMPT_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("biometric prompt timed out".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("biometric prompt cancelled".to_string())
        }
    }
}

fn entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|e| e.to_string())
}

/// Save `value` under `(service, account)`. Prompts Touch ID first.
/// Updates the session cache so subsequent reads in the same process
/// don't re-prompt.
///
/// Currently unused: the Gemini key now lives in a plain 0600 file
/// under `~/Library/Application Support/RLI/gemini-key`, so writes
/// don't go through the keychain anymore. We keep this function around
/// because the migration path (gemini.rs::load_key_for_use) still
/// reads legacy keychain entries on first launch — and if some future
/// secret needs Touch-ID-backed storage, the plumbing is here.
#[allow(dead_code)]
pub fn save_with_biometry(
    service: &str,
    account: &str,
    value: &str,
) -> Result<(), String> {
    prompt_biometry("save your Gemini API key")?;
    entry(service, account)?
        .set_password(value)
        .map_err(|e| e.to_string())?;
    cache_put(service, account, value.to_string());
    Ok(())
}

/// Read the value for `(service, account)`. Returns `Ok(None)` when no
/// entry exists.
///
/// Once authenticated in a given process run, the secret is held in a
/// session cache so we never re-prompt for the same entry. The first
/// call after launch goes through Touch ID; everything after is a
/// memory read. Quitting the app drops the cache.
pub fn load(service: &str, account: &str) -> Result<Option<String>, String> {
    // Fast path: same process already authenticated for this entry.
    // Skips the keychain ACL prompt AND the biometry prompt entirely.
    if let Some(cached) = cache_get(service, account) {
        return Ok(if cached.trim().is_empty() {
            None
        } else {
            Some(cached)
        });
    }

    // Cold path: prompt biometry, then read once from the keychain.
    // We don't pre-check existence with a separate `get_password` call
    // — that would trigger the macOS login-keychain ACL prompt twice
    // on dev builds whose signature hasn't been "Always Allow"-ed yet.
    prompt_biometry("unlock your Gemini API key")?;
    match entry(service, account)?.get_password() {
        Ok(value) => {
            if value.trim().is_empty() {
                Ok(None)
            } else {
                cache_put(service, account, value.clone());
                Ok(Some(value))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the entry under `(service, account)`. Idempotent — a missing
/// entry is treated as success. Prompts Touch ID first. Drops the
/// session cache for this entry so a subsequent `load` re-prompts.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    prompt_biometry("remove your Gemini API key")?;
    cache_drop(service, account);
    match entry(service, account)?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
