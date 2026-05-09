//! Worktree lifecycle. Each "worktree" in RLI corresponds to a real
//! `git worktree` checkout: one branch, one directory, one running
//! agent (claude / codex / gemini). Worktrees are created via the
//! sidebar's `+` action and archived via the row's hover-✕.
//!
//! Archive convention:
//!   - JSON metadata: `<app_data_dir>/archive/<projectId>/<worktreeId>.json`
//!   - Optional stash: `git stash push -u -m "rli-archive-<worktreeId>"` ran
//!     in the worktree before `git worktree remove`. Restores apply the
//!     matching stash.
//!   - Branch deletion is opt-in (deleteBranch flag).
//!
//! Worktree checkouts live under `<app_data_dir>/worktrees/<projectId>/<id>`
//! so they don't pollute the user's repo with `.rli/sessions/...` dirs.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRow {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub name: String,
    pub path: String,
    pub change_count: u32,
    pub agent_status: String,
    pub agent_cli: Option<String>,
    pub created_at: u64,
    pub tab_ids: Vec<String>,
    pub active_tab_id: Option<String>,
    pub right_panel: String,
    pub right_split_pct: u8,
    pub secondary_tab: String,
    pub secondary_pty_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRecord {
    pub id: String,
    pub project_id: String,
    pub branch: String,
    pub name: String,
    pub created_at: u64,
    pub archived_at: u64,
    pub last_summary: String,
    pub change_count_at_archive: u32,
    pub original_path: String,
    pub agent_cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash_ref: Option<String>,
}

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    if !Path::new(cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    output_to_string(out)
}

fn output_to_string(out: Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(format!(
            "git exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ))
    }
}

fn worktrees_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("worktrees").join(project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create worktree root: {e}"))?;
    Ok(dir)
}

fn archive_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("archive").join(project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create archive dir: {e}"))?;
    Ok(dir)
}

fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------
   Commands
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn worktree_list(project_path: String) -> Result<Vec<WorktreeRow>, String> {
    // Best-effort: parse `git worktree list --porcelain` and return rows.
    // Caller is responsible for assigning IDs that mirror frontend state.
    let raw = git(&project_path, &["worktree", "list", "--porcelain"]).await?;
    let mut rows = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.trim_start_matches("refs/heads/").to_string();
        } else if line.is_empty() && !path.is_empty() {
            let id = format!("w_{}", Uuid::new_v4().simple());
            rows.push(WorktreeRow {
                id,
                project_id: String::new(),
                branch: branch.clone(),
                name: branch.clone(),
                path: path.clone(),
                change_count: 0,
                agent_status: "idle".to_string(),
                agent_cli: None,
                created_at: now_millis(),
                tab_ids: vec![],
                active_tab_id: None,
                right_panel: "files".to_string(),
                right_split_pct: 60,
                secondary_tab: "terminal".to_string(),
                secondary_pty_id: format!("pty_secondary_{}", Uuid::new_v4().simple()),
            });
            path.clear();
            branch.clear();
        }
    }
    Ok(rows)
}

#[tauri::command]
pub async fn worktree_create(
    app: AppHandle,
    project_id: String,
    project_path: String,
    branch: String,
    label: String,
) -> Result<WorktreeRow, String> {
    let id = format!("w_{}", Uuid::new_v4().simple());
    let root = worktrees_root(&app, &project_id)?;
    let path = root.join(&id);
    let path_str = path.to_string_lossy().into_owned();

    // Try with -b (creates new branch). If branch already exists, fall back to
    // adding the existing branch.
    let result = git(
        &project_path,
        &["worktree", "add", "-b", &branch, &path_str],
    )
    .await;
    if result.is_err() {
        git(
            &project_path,
            &["worktree", "add", &path_str, &branch],
        )
        .await?;
    }

    let primary_tab = format!("t_{}", Uuid::new_v4().simple());
    let secondary_pty = format!("pty_{}", Uuid::new_v4().simple());

    Ok(WorktreeRow {
        id,
        project_id,
        branch,
        name: label,
        path: path_str,
        change_count: 0,
        agent_status: "idle".to_string(),
        agent_cli: None,
        created_at: now_millis(),
        tab_ids: vec![primary_tab.clone()],
        active_tab_id: Some(primary_tab),
        right_panel: "files".to_string(),
        right_split_pct: 60,
        secondary_tab: "terminal".to_string(),
        secondary_pty_id: secondary_pty,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_archive(
    app: AppHandle,
    worktree_id: String,
    project_id: String,
    branch: String,
    name: String,
    path: String,
    created_at: u64,
    last_summary: String,
    change_count_at_archive: u32,
    agent_cli: Option<String>,
    stash: bool,
    force: bool,
    delete_branch: bool,
) -> Result<ArchiveRecord, String> {
    let mut stash_ref = None;
    if stash {
        let msg = format!("rli-archive-{}", worktree_id);
        // Best effort — clean worktree → no stash → git returns non-zero.
        let _ = git(&path, &["stash", "push", "-u", "-m", &msg]).await;
        stash_ref = Some(msg);
    }

    let mut remove_args = vec!["worktree", "remove"];
    if force {
        remove_args.push("--force");
    }
    remove_args.push(path.as_str());
    git(&infer_repo_root(&path), &remove_args).await?;

    if delete_branch {
        let _ = git(&infer_repo_root(&path), &["branch", "-D", &branch]).await;
    }

    let record = ArchiveRecord {
        id: format!("a_{}", Uuid::new_v4().simple()),
        project_id: project_id.clone(),
        branch,
        name,
        created_at,
        archived_at: now_secs() * 1000,
        last_summary,
        change_count_at_archive,
        original_path: path,
        agent_cli,
        stash_ref,
    };

    let dir = archive_dir(&app, &project_id)?;
    let file = dir.join(format!("{}.json", record.id));
    let json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    fs::write(&file, json).map_err(|e| format!("write archive: {e}"))?;

    Ok(record)
}

#[tauri::command]
pub async fn worktree_restore(
    app: AppHandle,
    archive_id: String,
    project_id: String,
) -> Result<WorktreeRow, String> {
    let dir = archive_dir(&app, &project_id)?;
    let file = dir.join(format!("{}.json", archive_id));
    let raw = fs::read_to_string(&file).map_err(|e| format!("read archive: {e}"))?;
    let record: ArchiveRecord = serde_json::from_str(&raw)
        .map_err(|e| format!("parse archive: {e}"))?;

    let repo_root = infer_repo_root(&record.original_path);
    git(
        &repo_root,
        &["worktree", "add", &record.original_path, &record.branch],
    )
    .await?;

    if let Some(stash_msg) = &record.stash_ref {
        // Try `git stash list` to find the matching stash, then apply it.
        let list = git(&record.original_path, &["stash", "list"]).await?;
        if let Some(stash_idx) = list
            .lines()
            .position(|line| line.contains(stash_msg.as_str()))
        {
            let stash_ref = format!("stash@{{{stash_idx}}}");
            let _ = git(
                &record.original_path,
                &["stash", "apply", "--index", &stash_ref],
            )
            .await;
        }
    }

    // Remove the JSON marker — once restored, history is no longer holding it.
    let _ = fs::remove_file(&file);

    let primary_tab = format!("t_{}", Uuid::new_v4().simple());
    let secondary_pty = format!("pty_{}", Uuid::new_v4().simple());

    Ok(WorktreeRow {
        id: format!("w_{}", Uuid::new_v4().simple()),
        project_id,
        branch: record.branch,
        name: record.name,
        path: record.original_path,
        change_count: 0,
        agent_status: "idle".to_string(),
        agent_cli: record.agent_cli,
        created_at: record.created_at,
        tab_ids: vec![primary_tab.clone()],
        active_tab_id: Some(primary_tab),
        right_panel: "files".to_string(),
        right_split_pct: 60,
        secondary_tab: "terminal".to_string(),
        secondary_pty_id: secondary_pty,
    })
}

#[tauri::command]
pub async fn archive_list(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<ArchiveRecord>, String> {
    let dir = archive_dir(&app, &project_id)?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(record) = serde_json::from_str::<ArchiveRecord>(&raw) {
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Try to find the project repo root from a worktree path. Worktrees
/// created by us live under `<app_data>/worktrees/<projectId>/<id>`,
/// so we can't traverse parents to find a `.git` — those checkouts have
/// a `.git` file pointing back to the original repo. Calling git in the
/// worktree path itself is fine for `worktree remove` since git resolves
/// upward through `.git` files; we just default to the worktree path.
fn infer_repo_root(worktree_path: &str) -> String {
    worktree_path.to_string()
}
