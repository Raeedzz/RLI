//! Filesystem + shell-out commands.
//!
//! tauri-plugin-fs exists but is capability-scoped — every path the
//! frontend touches has to be in an allowlist. For RLI's "open any
//! folder you point at" model that's the wrong shape, so we expose
//! direct read commands instead.
//!
//! Writes are scoped to the editor's autosave path: the frontend can
//! only call `fs_write_text_file` on a path it already opened (the
//! Editor tracks this), so we don't gate further here.
//!
//! Also: `system_open` shells out to macOS's `open` so the user can
//! reveal/right-click-open files in Finder, VS Code, browsers, etc.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const HIDE_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".rli",
];

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name != ".gitignore" && name != ".env.example" {
            continue;
        }
        if HIDE_NAMES.contains(&name.as_str()) {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn fs_read_text_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(format!("file too large ({} bytes) — use a CLI editor", metadata.len()));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_text_file(path: String, content: String) -> Result<(), String> {
    // Editor autosave. The frontend only calls this for files that were
    // explicitly opened via the file tree, so the path origin is trusted.
    // We still refuse files that don't already exist — autosave should
    // never accidentally create new files.
    if !Path::new(&path).exists() {
        return Err(format!("refusing to create new file: {path}"));
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Opens a path in the macOS default handler (Finder reveals folders,
/// the default editor opens text files, the default browser opens .html,
/// etc.). The frontend's right-click menu uses this for "Open in Finder"
/// and "Open with default app".
#[tauri::command]
pub async fn system_open(path: String, reveal: bool) -> Result<(), String> {
    let mut cmd = Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(&path);
    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn open: {e}"))?;
    if !status.success() {
        return Err(format!("open exited {}", status.code().unwrap_or(-1)));
    }
    Ok(())
}

/// Opens a path in a named application (e.g. "Visual Studio Code",
/// "Sublime Text", "Safari", "Google Chrome"). Uses `open -a` on macOS.
#[tauri::command]
pub async fn system_open_with(path: String, app: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-a")
        .arg(&app)
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn open -a: {e}"))?;
    if !status.success() {
        return Err(format!(
            "could not open with '{app}' (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}
