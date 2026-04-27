/// RLI Tauri entry point.
///
/// Plugin set is the minimum needed for v1 features:
///   - shell:   spawn `git`, `rg`, `ast-grep`, etc.
///   - fs:      read project files, write per-session config
///   - dialog:  "Open Folder" picker
///   - os:      platform queries (we're macOS-only v1, but used for paths)
///   - process: required for the auto-update plugin's restart hook (Task #18)
///
/// Per-feature plumbing (PTY, git, Gemini, memory, MCP scan, GStack client)
/// is added in their respective tasks under `crate::commands::*`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            // Tauri commands registered here as features land.
            // Task #6 → pty::*, Task #8 → git::*, Task #11 → gemini::*, etc.
        ])
        .run(tauri::generate_context!())
        .expect("error while running RLI");
}
