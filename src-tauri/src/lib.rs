/// RLI Tauri entry point.
///
/// Plugin set is the minimum needed for v1 features:
///   - shell:   spawn `git`, `rg`, `ast-grep`, etc. from the frontend
///   - fs:      read project files, write per-session config
///   - dialog:  "Open Folder" picker
///   - os:      platform queries (we're macOS-only v1, but used for paths)
///   - process: required for the auto-update plugin's restart hook
///
/// Per-feature plumbing lives in `crate::*` modules — registered below.
mod connections;
mod fs;
mod gemini;
mod git;
mod memory;
mod search;
mod state;
mod term;

use gemini::GeminiState;
use memory::MemoryState;
use term::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .manage(TerminalState::default())
        .manage(GeminiState::default())
        .manage(MemoryState::default())
        .invoke_handler(tauri::generate_handler![
            // Terminal (alacritty_terminal + custom React renderer)
            term::term_start,
            term::term_input,
            term::term_resize,
            term::term_close,
            // Gemini (Task #11)
            gemini::gemini_set_key,
            gemini::gemini_clear_key,
            gemini::gemini_key_status,
            gemini::gemini_generate,
            gemini::gemini_embed,
            // Memory (Task #12)
            memory::memory_store,
            memory::memory_recall,
            memory::memory_delete,
            // Git (Task #8)
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_branch_current,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_log,
            git::git_ai_commit_message,
            // Connections (Task #10)
            connections::connections_scan,
            // Search (Task #15)
            search::search_rg,
            search::search_ast_grep,
            // Filesystem
            fs::fs_read_dir,
            fs::fs_read_text_file,
            fs::fs_write_text_file,
            fs::fs_cwd,
            fs::system_open,
            fs::system_open_with,
            // State persistence
            state::state_save,
            state::state_load,
            state::state_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RLI");
}
