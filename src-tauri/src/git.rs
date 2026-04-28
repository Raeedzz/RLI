//! Git layer — shells out to the system `git` for everything.
//!
//! Why shell out (per CONTEXT.md decision): correctness against the
//! user's existing git config, credentials, hooks, signing, LFS, and
//! submodules. Performance is fine — git operations happen at click
//! speed, not frame speed.
//!
//! This module exposes only what the v1 features need:
//!   - `status` — for the file tree dirty marks (deferred) + git panel
//!   - `diff` — for the git panel and AI commit messages
//!   - `stage`, `unstage`, `commit`, `push` — git panel actions
//!   - `branch_current`, `branch_create` — for session worktrees
//!   - `worktree_add`, `worktree_remove` — session lifecycle (Task #9)
//!   - `log` — for the merge-back UI
//!
//! AI commit messages live in this module too (`git_ai_commit_message`)
//! since they need both the staged diff and the Gemini client.

use std::path::Path;
use std::process::Output;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::gemini::{self, GeminiState, GenerateArgs};

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

async fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
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

/* ------------------------------------------------------------------
   Status — porcelain v2
   ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub kind: String, // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub staged: bool,
}

#[derive(Debug, Serialize)]
pub struct StatusResult {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<StatusResult, String> {
    let raw = run(&cwd, &["status", "--porcelain=v2", "--branch"]).await?;
    Ok(parse_status_v2(&raw))
}

fn parse_status_v2(raw: &str) -> StatusResult {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: "+<ahead> -<behind>"
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // Ordinary changed: "1 XY ... <path>"
            entries.push(parse_change_entry(rest, false));
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed/copied: "2 XY ... <path>\t<orig>"
            entries.push(parse_change_entry(rest, true));
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged
            let path = rest.split_whitespace().last().unwrap_or("").to_string();
            entries.push(StatusEntry {
                path,
                kind: "conflicted".into(),
                staged: false,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            entries.push(StatusEntry {
                path: rest.to_string(),
                kind: "untracked".into(),
                staged: false,
            });
        }
    }

    StatusResult {
        branch,
        upstream,
        ahead,
        behind,
        entries,
    }
}

fn parse_change_entry(rest: &str, renamed: bool) -> StatusEntry {
    // Ordinary: XY sub modeH modeI modeW hashH hashI <path>           — 8 tokens
    // Renamed:  XY sub modeH modeI modeW hashH hashI X<score> <path>\t<orig> — 9 tokens
    let xy = rest.split_whitespace().next().unwrap_or("..");
    let path_part = if renamed {
        rest.splitn(9, ' ').nth(8).unwrap_or("").to_string()
    } else {
        rest.splitn(8, ' ').nth(7).unwrap_or("").to_string()
    };
    let path = path_part
        .split_once('\t')
        .map(|(p, _)| p.to_string())
        .unwrap_or(path_part);

    let staged_char = xy.chars().next().unwrap_or('.');
    let work_char = xy.chars().nth(1).unwrap_or('.');
    let staged = staged_char != '.' && staged_char != ' ';

    let kind = match work_char {
        'M' => "modified",
        'A' | 'a' => "added",
        'D' | 'd' => "deleted",
        'R' | 'r' => "renamed",
        '.' | ' ' => match staged_char {
            'M' => "modified",
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            _ => "modified",
        },
        _ => "modified",
    }
    .to_string();

    StatusEntry { path, kind, staged }
}

/* ------------------------------------------------------------------
   Diff
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn git_diff(
    cwd: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    args.push("--no-color");
    if let Some(p) = path.as_deref() {
        args.push("--");
        args.push(p);
    }
    run(&cwd, &args).await
}

/* ------------------------------------------------------------------
   Stage / commit / push
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &paths {
        args.push(p);
    }
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for p in &paths {
        args.push(p);
    }
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message cannot be empty".into());
    }
    run(&cwd, &["commit", "-m", &message]).await
}

#[tauri::command]
pub async fn git_push(
    cwd: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["push"];
    let remote_owned;
    let branch_owned;
    if let Some(r) = remote.as_deref() {
        remote_owned = r.to_string();
        args.push(&remote_owned);
        if let Some(b) = branch.as_deref() {
            branch_owned = b.to_string();
            args.push(&branch_owned);
        }
    }
    run(&cwd, &args).await
}

/* ------------------------------------------------------------------
   Branches & worktrees (Task #9 builds on these)
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn git_branch_current(cwd: String) -> Result<String, String> {
    run(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
}

/// Local branches, sorted by recency of last commit. Used to populate
/// the BranchSwitcher popover. Each entry includes whether it's the
/// currently checked-out branch so the UI can mark it.
#[derive(Debug, Serialize)]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<Vec<BranchEntry>, String> {
    let raw = run(
        &cwd,
        &[
            "for-each-ref",
            "--format=%(HEAD)\t%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ],
    )
    .await?;
    Ok(raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let head = parts.next()?;
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(BranchEntry {
                name,
                current: head.trim() == "*",
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    run(&cwd, &["checkout", &branch]).await.map(|_| ())
}

/// Create a new branch from the current HEAD and check it out. If
/// `from` is provided, branches off that ref instead.
#[tauri::command]
pub async fn git_branch_create(
    cwd: String,
    name: String,
    from: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["checkout", "-b", name.as_str()];
    let from_owned: String;
    if let Some(f) = from.as_deref() {
        from_owned = f.to_string();
        args.push(&from_owned);
    }
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_add(
    cwd: String,
    path: String,
    branch: String,
) -> Result<(), String> {
    run(&cwd, &["worktree", "add", "-b", &branch, &path])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_remove(
    cwd: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    run(&cwd, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_log(cwd: String, n: Option<u32>) -> Result<Vec<LogEntry>, String> {
    let count = n.unwrap_or(20).to_string();
    let raw = run(
        &cwd,
        &[
            "log",
            "-n",
            &count,
            "--pretty=format:%H%x09%an%x09%ar%x09%s",
        ],
    )
    .await?;
    Ok(parse_log(&raw))
}

fn parse_log(raw: &str) -> Vec<LogEntry> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\t');
            Some(LogEntry {
                hash: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                relative_time: parts.next()?.to_string(),
                subject: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogEntry {
    pub hash: String,
    pub author: String,
    pub relative_time: String,
    pub subject: String,
}

/* ------------------------------------------------------------------
   AI commit message — Gemini Flash-Lite
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn git_ai_commit_message(
    state: State<'_, GeminiState>,
    cwd: String,
) -> Result<String, String> {
    // Get the staged diff plus a name-status header so the model has
    // a quick map of which files moved before reading the patch body.
    // We bump the truncation cap to 16KB now that the model produces
    // longer (multi-paragraph) bodies — clipping too aggressively
    // produces vague messages.
    let name_status = run(&cwd, &["diff", "--staged", "--name-status"]).await?;
    let diff = run(&cwd, &["diff", "--staged", "--no-color"]).await?;
    if diff.trim().is_empty() {
        return Err("no staged changes".into());
    }
    let trimmed_diff = if diff.len() > 16_000 {
        let mut s = diff.chars().take(16_000).collect::<String>();
        s.push_str("\n\n[…diff truncated to 16KB; remaining hunks omitted…]");
        s
    } else {
        diff
    };

    let system = "You write Conventional Commit messages for git diffs.\n\
\n\
Output ONLY the commit message — no preamble, no markdown fences, no quotes.\n\
\n\
FORMAT (strict):\n\
  <type>(<optional scope>): <imperative subject, ≤72 chars, lowercase, no trailing period>\n\
  <blank line>\n\
  <body: 1–3 short paragraphs OR 2–6 bulleted lines explaining WHAT changed and WHY>\n\
\n\
TYPES — pick the one that best matches the dominant change:\n\
  feat      new user-facing capability\n\
  fix       bug fix (mention the symptom)\n\
  refactor  internal restructure with no behavior change\n\
  perf      measurable performance improvement\n\
  docs      docs / comments only\n\
  test      tests only\n\
  chore     build, deps, tooling, config, housekeeping\n\
  build     build system or external dependency change\n\
  ci        CI pipeline / GitHub Actions / scripts\n\
  style     formatting, whitespace, lint-only fixes\n\
\n\
SCOPE — optional. Use a short module name when the change is localized\n\
(e.g. `feat(memory): …`, `fix(terminal): …`). Omit when the change\n\
spans many areas.\n\
\n\
BODY — required for anything that isn't a one-line change. Be specific:\n\
  - Name the user-visible behavior, the bug symptom, or the constraint\n\
    being addressed. Avoid filler like \"improve\", \"update\", \"various\".\n\
  - Explain WHY the change was needed when it isn't obvious from the diff.\n\
  - Mention notable trade-offs, follow-ups, or known limitations.\n\
  - Keep each line ≤100 chars; wrap into bullets if you have 3+ distinct\n\
    points.\n\
\n\
Skip the body ONLY for genuinely trivial changes (typo fix, version\n\
bump, single import re-order). Otherwise always include one.\n\
\n\
Tone: terse, imperative, technically precise. No hedging, no marketing\n\
language, no emoji.";
    let prompt = format!(
        "Write a commit message for this staged change.\n\n\
         FILES (name-status):\n{name_status}\n\n\
         DIFF:\n{trimmed_diff}",
    );

    let msg = gemini::gemini_generate(
        state,
        GenerateArgs {
            prompt,
            system: Some(system.to_string()),
            // Bumped from 200 → 600 so multi-bullet bodies aren't cut off.
            max_tokens: Some(600),
            // Slightly lower temperature than before — convention adherence
            // matters more than novelty for commit messages.
            temperature: Some(0.25),
        },
    )
    .await?;

    Ok(msg.trim().to_string())
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_head_and_upstream() {
        let raw = "# branch.oid abc123\n\
                   # branch.head main\n\
                   # branch.upstream origin/main\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn detached_head_leaves_branch_none() {
        let raw = "# branch.head (detached)\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch, None);
    }

    #[test]
    fn parses_branch_ab_into_ahead_and_behind() {
        let raw = "# branch.ab +3 -1\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.ahead, 3);
        assert_eq!(r.behind, 1);
    }

    #[test]
    fn branch_ab_with_zero_zero() {
        let raw = "# branch.ab +0 -0\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    #[test]
    fn parses_unstaged_modified_entry() {
        // XY = .M → unstaged worktree modification
        let raw = "1 .M N... 100644 100644 100644 abc def src/main.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/main.rs");
        assert_eq!(e.kind, "modified");
        assert!(!e.staged);
    }

    #[test]
    fn parses_staged_modified_entry() {
        // XY = M. → staged modification, worktree clean
        let raw = "1 M. N... 100644 100644 100644 abc def src/main.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/main.rs");
        assert_eq!(e.kind, "modified");
        assert!(e.staged);
    }

    #[test]
    fn parses_staged_added_entry() {
        // XY = A. → staged add
        let raw = "1 A. N... 000000 100644 100644 0000000 abc src/new_file.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/new_file.rs");
        assert_eq!(e.kind, "added");
        assert!(e.staged);
    }

    #[test]
    fn parses_staged_deleted_entry() {
        let raw = "1 D. N... 100644 000000 000000 abc 0000000 src/gone.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/gone.rs");
        assert_eq!(e.kind, "deleted");
        assert!(e.staged);
    }

    #[test]
    fn parses_untracked_entry() {
        let raw = "? src/foo.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/foo.rs");
        assert_eq!(e.kind, "untracked");
        assert!(!e.staged);
    }

    #[test]
    fn parses_conflicted_entry() {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path  (10 tokens after the 'u ' prefix)
        let raw = "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/conflict.rs");
        assert_eq!(e.kind, "conflicted");
    }

    #[test]
    fn parses_renamed_entry_extracts_new_path() {
        // 2 XY sub modeH modeI modeW hashH hashI <X><score> <new>\t<old>
        let raw = "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.entries.len(), 1);
        let e = &r.entries[0];
        assert_eq!(e.path, "src/new.rs");
        assert_eq!(e.kind, "renamed");
        assert!(e.staged);
    }

    #[test]
    fn full_status_with_branch_and_mixed_entries() {
        let raw = "# branch.oid abc123\n\
                   # branch.head feature/auth\n\
                   # branch.upstream origin/feature/auth\n\
                   # branch.ab +2 -3\n\
                   1 .M N... 100644 100644 100644 abc def src/lib.rs\n\
                   1 M. N... 100644 100644 100644 abc def src/main.rs\n\
                   ? README.new\n\
                   2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let r = parse_status_v2(raw);
        assert_eq!(r.branch.as_deref(), Some("feature/auth"));
        assert_eq!(r.upstream.as_deref(), Some("origin/feature/auth"));
        assert_eq!(r.ahead, 2);
        assert_eq!(r.behind, 3);
        assert_eq!(r.entries.len(), 4);

        assert_eq!(r.entries[0].path, "src/lib.rs");
        assert_eq!(r.entries[0].kind, "modified");
        assert!(!r.entries[0].staged);

        assert_eq!(r.entries[1].path, "src/main.rs");
        assert_eq!(r.entries[1].kind, "modified");
        assert!(r.entries[1].staged);

        assert_eq!(r.entries[2].path, "README.new");
        assert_eq!(r.entries[2].kind, "untracked");
        assert!(!r.entries[2].staged);

        assert_eq!(r.entries[3].path, "src/new.rs");
        assert_eq!(r.entries[3].kind, "renamed");
        assert!(r.entries[3].staged);
    }

    #[test]
    fn empty_status_returns_no_entries() {
        let r = parse_status_v2("");
        assert!(r.entries.is_empty());
        assert_eq!(r.branch, None);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    /* ---------- log parser ---------- */

    #[test]
    fn parses_single_log_entry() {
        let raw = "abc1234\tRaeed\t2 days ago\tfix the parser bug\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hash, "abc1234");
        assert_eq!(entries[0].author, "Raeed");
        assert_eq!(entries[0].relative_time, "2 days ago");
        assert_eq!(entries[0].subject, "fix the parser bug");
    }

    #[test]
    fn parses_multiple_log_entries() {
        let raw = "h1\tA\t1 day ago\tfirst\n\
                   h2\tB\t2 days ago\tsecond\n\
                   h3\tC\t3 days ago\tthird\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].subject, "first");
        assert_eq!(entries[1].author, "B");
        assert_eq!(entries[2].hash, "h3");
    }

    #[test]
    fn parse_log_skips_blank_lines() {
        let raw = "\n\
                   h1\tA\t1 day ago\ttest\n\
                   \n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn parse_log_preserves_tabs_in_subject() {
        // splitn(4, '\t') keeps the rest of the line — including tabs — in the subject.
        let raw = "h1\tA\t1d\tsubject\twith\ttabs\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, "subject\twith\ttabs");
    }

    #[test]
    fn parse_log_empty_input_returns_empty() {
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn parse_log_subject_with_unicode() {
        let raw = "h1\tÅlex\t1 hour ago\t✨ initial commit\n";
        let entries = parse_log(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].author, "Ålex");
        assert_eq!(entries[0].subject, "✨ initial commit");
    }

    #[test]
    fn parse_log_malformed_line_is_skipped() {
        let raw = "h1\tA\t1d\tgood\n\
                   no_tabs_here\n\
                   h2\tB\t2d\talso good\n";
        let entries = parse_log(raw);
        // The malformed line lacks the required hash/author/time fields.
        // splitn produces only 1 part → parts.next() returns hash but parts.next() for
        // author returns None → ? short-circuits filter_map, dropping the line.
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "good");
        assert_eq!(entries[1].subject, "also good");
    }
}
