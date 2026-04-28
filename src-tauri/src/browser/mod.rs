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
use tokio::sync::RwLock;

use chrome::ChromeSession;

/// Lives in Tauri's managed-state. Holds the lazy-initialized Chrome
/// session — `None` until the first /navigate or /screenshot HTTP call.
/// The inner `Arc<ChromeSession>` lets handlers clone a cheap reference
/// out of the lock so the write-lock isn't held for the whole request.
#[derive(Default, Clone)]
pub struct BrowserState {
    pub session: Arc<RwLock<Option<Arc<ChromeSession>>>>,
}
