/// GLI Tauri entry point.
///
/// Plugin set is the minimum needed for v1 features:
///   - shell:   spawn `git`, `rg`, etc. from the frontend
///   - fs:      read project files, write per-session config
///   - dialog:  "Open Folder" picker
///   - os:      platform queries (we're macOS-only v1, but used for paths)
///   - process: required for the auto-update plugin's restart hook
///   - updater: pulls signed updates from GitHub Releases on a check
///
/// Per-feature plumbing lives in `crate::*` modules — registered below.
#[cfg(target_os = "macos")]
mod browser;
mod claude_usage;
mod connections;
mod fs;
mod git;
mod helper_agent;
mod pr;
mod search;
mod state;
mod term;
mod worktree;

#[cfg(target_os = "macos")]
use browser::BrowserState;
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
        .manage(TerminalState::default());

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
            // Claude usage (real, from ~/.claude/projects transcripts)
            claude_usage::claude_usage_status,
            claude_usage::claude_activity_summary,
            // Git (Task #8)
            git::git_status,
            git::git_diff,
            git::git_diff_all,
            git::git_diff_stat,
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
            search::search_files,
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

/// One-shot migration of the previous `dev.raeedz.rli` Application
/// Support directory to the new `dev.raeedz.gli` location. Tauri's
/// `app_data_dir()` resolves off the bundle identifier, so a rename
/// of the identifier orphans state.json and the worktrees archive.
/// We move the old tree across once on first launch under the new
/// identifier — no-op afterwards.
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
