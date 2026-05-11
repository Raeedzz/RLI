//! In-house headless-browser daemon — a drop-in replacement for the
//! gstack daemon that gstack ships, exposing the same HTTP contract on
//! `http://127.0.0.1:4000` plus a few new POST routes for interactive
//! input forwarding.
//!
//! See `/Users/raeedz/.claude/plans/zippy-riding-micali.md` for the
//! design + rationale.

#![cfg(target_os = "macos")]

pub mod binary;
pub mod chrome;
pub mod daemon;

use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use tokio::sync::RwLock;

use chrome::ChromeSession;

/// Lives in Tauri's managed-state. Holds the lazy-initialized Chrome
/// session — `None` until the first /navigate or /screenshot HTTP call.
/// The inner `Arc<ChromeSession>` lets handlers clone a cheap reference
/// out of the lock so the write-lock isn't held for the whole request.
///
/// Also publishes the daemon's bound port (0 = not yet bound) so the
/// rest of the app — specifically `term.rs` injecting `GLI_BROWSER_URL`
/// into PTY child env — can read the actual URL instead of guessing
/// at the default 4000.
#[derive(Default, Clone)]
pub struct BrowserState {
    pub session: Arc<RwLock<Option<Arc<ChromeSession>>>>,
    pub bound_port: Arc<AtomicU16>,
}

impl BrowserState {
    /// Read the daemon's bound port. Returns `None` until the daemon
    /// has successfully bound a listener.
    pub fn port(&self) -> Option<u16> {
        let p = self.bound_port.load(Ordering::Relaxed);
        if p == 0 { None } else { Some(p) }
    }
}
