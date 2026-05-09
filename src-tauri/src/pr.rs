//! Pull request creation. Drafts title + body via the worktree's
//! helper agent (Claude / Codex / Gemini), submits via `gh pr create`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::helper_agent::{run_inline, HelperMode};

#[derive(Debug, Serialize, Deserialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrCreated {
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrStatus {
    pub exists: bool,
    pub number: Option<u64>,
    pub url: Option<String>,
    /// One of OPEN, CLOSED, MERGED. None when no PR exists.
    pub state: Option<String>,
    /// One of MERGEABLE, CONFLICTING, UNKNOWN. None when no PR exists.
    pub mergeable: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResult {
    pub conflicts: bool,
    pub files: Vec<String>,
    /// True when local main was already up-to-date (no merge happened).
    pub already_up_to_date: bool,
}

#[tauri::command]
pub async fn pr_draft(
    cwd: String,
    cli: String,
    model: Option<String>,
) -> Result<PrDraft, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }

    // Gather context: staged + unstaged diff (truncated) and the last
    // few commit subjects.
    let staged_diff = run_git(&cwd, &["diff", "--staged", "--no-color"]).await?;
    let working_diff = run_git(&cwd, &["diff", "--no-color"]).await?;
    let log = run_git(&cwd, &["log", "-n", "10", "--pretty=format:%s"]).await?;

    let mut prompt = String::new();
    prompt.push_str("Recent commit subjects:\n");
    prompt.push_str(&log);
    prompt.push_str("\n\nStaged diff:\n");
    prompt.push_str(&truncate(&staged_diff, 4000));
    prompt.push_str("\n\nWorking-tree diff:\n");
    prompt.push_str(&truncate(&working_diff, 4000));

    let raw =
        run_inline(&cwd, &cli, HelperMode::PrDescription, &prompt, model.as_deref()).await?;

    // Best-effort JSON extract. Some CLIs include preamble despite
    // instructions; we look for the first `{` and parse from there.
    let json_start = raw.find('{').unwrap_or(0);
    let json_end = raw.rfind('}').map(|i| i + 1).unwrap_or(raw.len());
    let slice = &raw[json_start..json_end];

    let draft: PrDraft = serde_json::from_str(slice).unwrap_or(PrDraft {
        title: first_line(&raw).to_string(),
        body: raw,
    });
    Ok(draft)
}

#[tauri::command]
pub async fn pr_create(
    cwd: String,
    title: String,
    body: String,
) -> Result<PrCreated, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let out = Command::new("gh")
        .args(["pr", "create", "--title", &title, "--body", &body])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}. Is GitHub CLI installed? `brew install gh`"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "gh exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let url = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with("https://"))
        .unwrap_or(stdout.as_str())
        .to_string();
    Ok(PrCreated { url })
}

/// Look up a PR for the worktree's branch via `gh pr view <branch>`.
/// Used by the chrome to flip the top-right button between Create-PR
/// and Merge once an open PR exists.
#[tauri::command]
pub async fn pr_status(cwd: String, branch: String) -> Result<PrStatus, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    if branch.is_empty() {
        return Ok(PrStatus {
            exists: false,
            number: None,
            url: None,
            state: None,
            mergeable: None,
        });
    }
    let out = Command::new("gh")
        .args([
            "pr",
            "view",
            &branch,
            "--json",
            "number,url,state,mergeable",
        ])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}. Is GitHub CLI installed? `brew install gh`"))?;
    if !out.status.success() {
        // No PR for this branch is the common no-PR case; gh exits
        // non-zero with a "no pull requests found" message. Treat as
        // "not yet created" rather than an error.
        return Ok(PrStatus {
            exists: false,
            number: None,
            url: None,
            state: None,
            mergeable: None,
        });
    }
    #[derive(Deserialize)]
    struct ViewJson {
        number: u64,
        url: String,
        state: String,
        mergeable: String,
    }
    let parsed: ViewJson = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("parse gh json: {e}"))?;
    Ok(PrStatus {
        exists: true,
        number: Some(parsed.number),
        url: Some(parsed.url),
        state: Some(parsed.state),
        mergeable: Some(parsed.mergeable),
    })
}

/// Merge a PR via `gh pr merge` — server-side merge using the user's
/// existing GitHub auth. Defaults to `--merge` (merge commit). Pass
/// `"squash"` or `"rebase"` to override. Branch is deleted on remote
/// after a successful merge so the worktree's archive flow can be
/// followed up cleanly.
#[tauri::command]
pub async fn pr_merge(
    cwd: String,
    number: u64,
    method: String,
) -> Result<(), String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let num = number.to_string();
    let out = Command::new("gh")
        .args(["pr", "merge", &num, flag, "--delete-branch"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("spawn gh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "gh pr merge failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Pull latest `<base>` from origin and merge it into the current
/// branch in the worktree. Surfaces conflict file paths so the chrome
/// can name them when delegating resolution to the agent. The merge is
/// left in-progress on conflict so the user / agent can edit and then
/// `git add` + `git commit` to finalize.
#[tauri::command]
pub async fn merge_base_into_branch(
    cwd: String,
    base: String,
) -> Result<ConflictResult, String> {
    if !Path::new(&cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    let base = if base.is_empty() {
        "main".to_string()
    } else {
        base
    };

    let _ = Command::new("git")
        .args(["fetch", "origin", &base])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("git fetch: {e}"))?;

    let merge_target = format!("origin/{base}");
    let out = Command::new("git")
        .args(["merge", "--no-edit", "--no-ff", &merge_target])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("git merge: {e}"))?;

    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let already = stdout.contains("Already up to date")
            || stdout.contains("Already up-to-date");
        return Ok(ConflictResult {
            conflicts: false,
            files: vec![],
            already_up_to_date: already,
        });
    }

    // Probably conflicts. Confirm by listing unmerged paths.
    let lsout = Command::new("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("ls conflicts: {e}"))?;
    let files: Vec<String> = String::from_utf8_lossy(&lsout.stdout)
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if files.is_empty() {
        // Merge failed for some other reason — surface the stderr so
        // we don't silently strand the user mid-operation.
        return Err(format!(
            "git merge failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(ConflictResult {
        conflicts: true,
        files,
        already_up_to_date: false,
    })
}

async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("spawn git: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut head: String = s.chars().take(max).collect();
    head.push_str("\n…[truncated]…");
    head
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or(s)
}
