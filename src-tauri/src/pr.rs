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

#[tauri::command]
pub async fn pr_draft(
    cwd: String,
    cli: String,
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

    let raw = run_inline(&cwd, &cli, HelperMode::PrDescription, &prompt).await?;

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
