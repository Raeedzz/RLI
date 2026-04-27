//! App-state persistence.
//!
//! The frontend's `AppState` (projects + sessions + layout + open files)
//! is the source of truth at runtime. To survive restarts we serialize
//! the persistent slice to JSON and stash it in the platform's app-data
//! directory:
//!
//!   macOS: ~/Library/Application Support/dev.raeedz.rli/state.json
//!
//! Why a single file (instead of per-table SQLite or tauri-plugin-store):
//!   - The state is small (KBs, not MBs) — sessions are mostly metadata.
//!   - One JSON blob is trivial to inspect / edit / delete during dev.
//!   - We already write to disk for memory.db and gemini keys; another
//!     file in the same directory keeps the layout obvious.
//!
//! Atomicity: writes go to `state.json.tmp` first, then `rename` swaps
//! it into place. If the process crashes mid-write the prior file is
//! intact — the user never wakes up to a half-flushed state.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

const STATE_FILE: &str = "state.json";

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

#[tauri::command]
pub fn state_save<R: Runtime>(app: AppHandle<R>, content: String) -> Result<(), String> {
    let path = state_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &content).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn state_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read state.json: {e}"))
}

#[tauri::command]
pub fn state_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = state_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove state.json: {e}"))?;
    }
    Ok(())
}
