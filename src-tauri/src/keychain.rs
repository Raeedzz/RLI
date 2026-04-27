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

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use keyring::Entry;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};

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
pub fn save_with_biometry(
    service: &str,
    account: &str,
    value: &str,
) -> Result<(), String> {
    prompt_biometry("save your Gemini API key")?;
    entry(service, account)?
        .set_password(value)
        .map_err(|e| e.to_string())
}

/// Read the value for `(service, account)`. Returns `Ok(None)` when no
/// entry exists. Prompts Touch ID first; the prompt is skipped only on
/// the very first call where there's nothing to read yet.
pub fn load(service: &str, account: &str) -> Result<Option<String>, String> {
    // Cheap pre-check: don't burn a Touch ID prompt if there's nothing
    // stored. `keyring`'s `get_password` returns `NoEntry` when the
    // generic-password row is missing.
    match entry(service, account)?.get_password() {
        Ok(_) => {
            // The entry exists — re-read it after authenticating so the
            // user explicitly authorizes the access.
            prompt_biometry("unlock your Gemini API key")?;
            entry(service, account)?
                .get_password()
                .map(|s| if s.trim().is_empty() { None } else { Some(s) })
                .map_err(|e| e.to_string())
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete the entry under `(service, account)`. Idempotent — a missing
/// entry is treated as success. Prompts Touch ID first.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    prompt_biometry("remove your Gemini API key")?;
    match entry(service, account)?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
