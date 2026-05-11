/// GLI Tauri entry point.
///
/// Plugin set is the minimum needed for v1 features:
///   - shell:   spawn `git`, `rg`, `ast-grep`, etc. from the frontend
///   - fs:      read project files, write per-session config
///   - dialog:  "Open Folder" picker
///   - os:      platform queries (we're macOS-only v1, but used for paths)
///   - process: required for the auto-update plugin's restart hook
///   - updater: pulls signed updates from GitHub Releases on a check
///
/// Per-feature plumbing lives in `crate::*` modules — registered below.
#[cfg(target_os = "macos")]
mod browser;
mod claude_mem;
mod claude_usage;
mod connections;
mod fs;
mod git;
mod helper_agent;
mod memory;
mod pr;
mod search;
mod state;
mod term;
mod worktree;

#[cfg(target_os = "macos")]
use browser::BrowserState;
use memory::MemoryState;
use term::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalState::default())
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
            // GLI_MEMORY_URL injected into each PTY's env (term.rs).
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

            // One-time `~/.local/bin/gli-memory` install. Drops the
            // bundled bash wrapper so users (and agents inside GLI
            // panes) can invoke `gli-memory add/recall/extract` from
            // anywhere on PATH. No-op if the file is already present
            // and matches the bundled version. Best-effort prunes the
            // legacy `~/.local/bin/rli-memory` from prior installs.
            install_memory_cli();
            migrate_legacy_app_data();
            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            // Terminal (alacritty_terminal + custom React renderer)
            term::term_start,
            term::term_input,
            term::term_resize,
            term::term_close,
            // Memory (Task #12)
            memory::memory_store,
            memory::memory_recall,
            memory::memory_delete,
            memory::memory_graph_data,
            // claude-mem corpus graph (Obsidian-style view over ~/.claude-mem)
            claude_mem::claude_mem_graph,
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
            git::git_remotes,
            git::git_checkout,
            git::git_branch_create,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_log,
            // Worktree lifecycle (v2 UI rewrite)
            worktree::worktree_list,
            worktree::worktree_create,
            worktree::worktree_archive,
            worktree::worktree_restore,
            worktree::archive_list,
            // Helper agent (claude/codex/gemini one-shot)
            helper_agent::helper_run,
            helper_agent::detect_agent,
            // Pull request creation
            pr::pr_draft,
            pr::pr_create,
            pr::pr_status,
            pr::pr_merge,
            pr::merge_base_into_branch,
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
            fs::system_home_dir,
            fs::system_open,
            fs::system_open_with,
            // State persistence
            state::state_save,
            state::state_load,
            state::state_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GLI");
}

/// Bundled `gli-memory` CLI script. Embedded at compile-time so we
/// don't have to ship the `scripts/` dir alongside the .app — a single
/// `cargo build` produces a self-contained binary that knows how to
/// install its own CLI helper.
const GLI_MEMORY_SCRIPT: &str = include_str!("../../scripts/gli-memory");

/// First-launch install of `gli-memory` to `~/.local/bin/gli-memory`.
/// No-op if the file is already present and matches the bundled
/// content; otherwise overwrites + chmods +x. Failures are logged to
/// stderr only — they should never block app startup. Also removes
/// the legacy `~/.local/bin/rli-memory` from previous installs.
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
    let dest = bin.join("gli-memory");
    let needs_write = match std::fs::read_to_string(&dest) {
        Ok(existing) => existing != GLI_MEMORY_SCRIPT,
        Err(_) => true,
    };
    if needs_write {
        if let Err(e) = std::fs::write(&dest, GLI_MEMORY_SCRIPT) {
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

    // Sweep up the legacy install from prior `rli-memory` releases.
    let legacy = bin.join("rli-memory");
    if legacy.exists() {
        let _ = std::fs::remove_file(&legacy);
    }

    // Friendly nudge if ~/.local/bin isn't on PATH. We don't try to
    // mutate the user's shell rc — that's their territory.
    let path = std::env::var("PATH").unwrap_or_default();
    let needle = bin.to_string_lossy();
    if !path.split(':').any(|p| p == needle) {
        eprintln!(
            "[memory cli] note: {} is not on $PATH. Add it (e.g. `export PATH=\"$HOME/.local/bin:$PATH\"` in your ~/.zshrc) so `gli-memory` is callable from any shell.",
            needle
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn install_memory_cli() {}

/// One-shot migration of the previous `dev.raeedz.rli` Application
/// Support directory to the new `dev.raeedz.gli` location. Tauri's
/// `app_data_dir()` resolves off the bundle identifier, so a rename
/// of the identifier orphans state.json, the worktrees archive, and
/// the memory-port file. We move the old tree across once on first
/// launch under the new identifier — no-op afterwards.
#[cfg(target_os = "macos")]
fn migrate_legacy_app_data() {
    let Some(home) = dirs::home_dir() else { return };
    let support = home.join("Library").join("Application Support");
    let old = support.join("dev.raeedz.rli");
    let new = support.join("dev.raeedz.gli");
    if !old.exists() || new.exists() {
        return;
    }
    if let Err(e) = std::fs::rename(&old, &new) {
        eprintln!(
            "[migrate] couldn't rename {} → {}: {e}",
            old.display(),
            new.display()
        );
    } else {
        eprintln!(
            "[migrate] moved app data {} → {}",
            old.display(),
            new.display()
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn migrate_legacy_app_data() {}
