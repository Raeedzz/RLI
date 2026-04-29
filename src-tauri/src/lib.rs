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
#[cfg(target_os = "macos")]
mod browser;
mod claude_usage;
mod connections;
mod fs;
mod gemini;
mod git;
#[cfg(target_os = "macos")]
mod keychain;
mod memory;
mod search;
mod state;
mod term;

#[cfg(target_os = "macos")]
use browser::BrowserState;
use gemini::GeminiState;
use memory::MemoryState;
use tauri::Manager;
use term::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .manage(TerminalState::default())
        .manage(GeminiState::default())
        .manage(MemoryState::default())
        .manage(memory::daemon::MemoryDaemonPort::default());

    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(BrowserState::default())
        .setup(|app| {
            // Browser daemon: in-house replacement for gstack's
            // localhost:4000 service. Binds the port + spawns the axum
            // server in the background; Chrome itself is forked lazily
            // on the first /navigate or /screenshot HTTP call.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match browser::daemon::start(handle).await {
                    Ok(port) => eprintln!("[browser daemon] bound on 127.0.0.1:{port}"),
                    Err(e) => eprintln!("[browser daemon] failed to start: {e}"),
                }
            });

            // Memory daemon: serves /memory/{add,search,extract} on
            // 5555..5599. Discoverable via the memory-port file or via
            // RLI_MEMORY_URL injected into each PTY's env (term.rs).
            // Any agent in any pane can curl the routes through the
            // bash wrapper — that's how mem0-style "CLI-wide" reach
            // is actually achieved.
            let handle_mem = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match memory::daemon::start(handle_mem).await {
                    Ok(port) => eprintln!("[memory daemon] bound on 127.0.0.1:{port}"),
                    Err(e) => eprintln!("[memory daemon] failed to start: {e}"),
                }
            });

            // One-time `~/.local/bin/rli-memory` install. Drops the
            // bundled bash wrapper so users (and agents inside RLI
            // panes) can invoke `rli-memory add/recall/extract` from
            // anywhere on PATH. No-op if the file is already present
            // and matches the bundled version.
            install_memory_cli();

            // Eagerly warm the Gemini key cache from disk. The file
            // read never prompts (no Touch ID, no keychain ACL), so
            // this is free — and means the user's FIRST gemini call
            // (commit message, AskCard, session summary, anything)
            // hits a hot cache and returns immediately. No more
            // password/fingerprint friction at action time.
            let gemini_state = app.state::<GeminiState>();
            gemini::warm_cache_from_disk(&gemini_state);
            Ok(())
        });

    builder
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
            memory::memory_graph_data,
            // Claude usage (real, from ~/.claude/projects transcripts)
            claude_usage::claude_usage_status,
            claude_usage::claude_activity_summary,
            // Git (Task #8)
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_branch_current,
            git::git_branch_list,
            git::git_checkout,
            git::git_branch_create,
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

/// Bundled `rli-memory` CLI script. Embedded at compile-time so we
/// don't have to ship the `scripts/` dir alongside the .app — a single
/// `cargo build` produces a self-contained binary that knows how to
/// install its own CLI helper.
const RLI_MEMORY_SCRIPT: &str = include_str!("../../scripts/rli-memory");

/// First-launch install of `rli-memory` to `~/.local/bin/rli-memory`.
/// No-op if the file is already present and matches the bundled
/// content; otherwise overwrites + chmods +x. Failures are logged to
/// stderr only — they should never block app startup.
#[cfg(target_os = "macos")]
fn install_memory_cli() {
    let Some(home) = dirs::home_dir() else {
        eprintln!("[memory cli] couldn't resolve $HOME — skipping install");
        return;
    };
    let bin = home.join(".local").join("bin");
    if let Err(e) = std::fs::create_dir_all(&bin) {
        eprintln!("[memory cli] could not create {}: {e}", bin.display());
        return;
    }
    let dest = bin.join("rli-memory");
    let needs_write = match std::fs::read_to_string(&dest) {
        Ok(existing) => existing != RLI_MEMORY_SCRIPT,
        Err(_) => true,
    };
    if needs_write {
        if let Err(e) = std::fs::write(&dest, RLI_MEMORY_SCRIPT) {
            eprintln!("[memory cli] write failed: {e}");
            return;
        }
        // chmod 0755 so the user's shell can exec it directly.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &dest,
                std::fs::Permissions::from_mode(0o755),
            );
        }
        eprintln!("[memory cli] installed → {}", dest.display());
    }

    // Friendly nudge if ~/.local/bin isn't on PATH. We don't try to
    // mutate the user's shell rc — that's their territory.
    let path = std::env::var("PATH").unwrap_or_default();
    let needle = bin.to_string_lossy();
    if !path.split(':').any(|p| p == needle) {
        eprintln!(
            "[memory cli] note: {} is not on $PATH. Add it (e.g. `export PATH=\"$HOME/.local/bin:$PATH\"` in your ~/.zshrc) so `rli-memory` is callable from any shell.",
            needle
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn install_memory_cli() {}
