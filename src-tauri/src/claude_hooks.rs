//! Claude Code hook integration.
//!
//! Replaces the transcript-mtime polling we were using for the sidebar
//! spinner with a push-based event stream sourced from Claude Code's
//! native hook system. Modeled after Notchi (sk-ruban/notchi) — same
//! basic shape: a small shell script installed into `~/.claude/hooks/`
//! runs on every hook event, opens a Unix socket to this process, and
//! forwards a JSON envelope describing what just happened.
//!
//! Flow:
//!
//! ```text
//!   Claude Code  ─[hook event]─▶  gli-claude-hook.sh
//!                                      │
//!                                      ▼
//!                              /tmp/gli-claude.sock
//!                                      │
//!                                      ▼
//!                          ClaudeHookState (session map)
//!                                      │
//!                                      ▼
//!                         "claude://session/state" Tauri event
//!                                      │
//!                                      ▼
//!                              React sidebar spinner
//! ```
//!
//! The hook script is baked into the binary via `include_str!` so we
//! don't need to chase bundle-resource paths at runtime — `install_hooks`
//! writes it to `~/.claude/hooks/gli-claude-hook.sh` (0755) and upserts
//! the matching entries in `~/.claude/settings.json`, preserving any
//! existing user hooks. The settings merge is idempotent: re-running it
//! over already-installed entries no-ops.

use std::fs;
use std::io::Read;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The hook script body, embedded at compile time. See
/// `resources/gli-claude-hook.sh`. The script is tiny on purpose — it
/// just forwards every payload to the Unix socket. Status classification
/// lives in Rust (`classify_event`) so we can change the rules without
/// re-installing the script.
const HOOK_SCRIPT: &str = include_str!("../resources/gli-claude-hook.sh");

/// Where the socket binds. `/tmp/` is owned by the user on macOS, and
/// `chmod 0600` later restricts access to the running user. Single
/// listener — if a previous GLI instance crashed and left a stale path,
/// we unlink before binding.
const SOCKET_PATH: &str = "/tmp/gli-claude.sock";

/// Event name we emit on every state change. Frontend listens once at
/// app boot and updates a singleton store.
pub const SESSION_STATE_EVENT: &str = "claude://session/state";

/// Per-session status. The sidebar spinner maps `is_running()` on each
/// of these to decide whether to spin.
///
/// Mirrors Notchi's classification — same four buckets, plus `Ended`
/// for the SessionEnd eviction marker. The `Idle` / `Waiting` split
/// matters for sound effects / sprites (one is "clean done", the
/// other is "paused on user input"); for the spinner alone both
/// resolve to no-spin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Agent is actively processing (post-prompt, mid-tool, etc.).
    Working,
    /// Agent is compacting context.
    Compacting,
    /// Agent paused on a tool that needs user attention — permission
    /// prompt, `AskUserQuestion`. Distinct from `Idle` because a
    /// follow-up event is expected once the user answers.
    Waiting,
    /// Agent has finished a turn and is sitting at its input box for
    /// the next user prompt. Fired by `Stop` / `SubagentStop`.
    Idle,
    /// Session ended cleanly. Evicted from the map on receipt.
    Ended,
}

impl SessionStatus {
    /// True when the spinner should be spinning. Kept as a method so
    /// the same classification rule is shared between the (current)
    /// frontend consumer and any future Rust-side consumer (e.g. a
    /// menubar indicator). Frontend currently matches on the
    /// serialized string form, hence the `allow(dead_code)`.
    #[allow(dead_code)]
    pub fn is_running(self) -> bool {
        matches!(self, SessionStatus::Working | SessionStatus::Compacting)
    }
}

/// One row in the session map. Keyed by `session_id` so concurrent
/// Claude sessions in different worktrees don't collide.
#[derive(Debug, Clone, Serialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub cwd: String,
    pub status: SessionStatus,
    /// Last hook event we observed, for the live activity line.
    pub last_event: String,
    /// Last tool name observed during a PreToolUse/PostToolUse — surfaces
    /// to the live activity summary so the user can see "Bash", "Edit",
    /// etc. Empty string when not applicable.
    pub last_tool: String,
    /// Wall-clock ms since UNIX epoch when this record was last touched.
    pub updated_at_ms: u64,
}

#[derive(Default)]
pub struct ClaudeHookState {
    sessions: Mutex<std::collections::HashMap<String, SessionRecord>>,
}

impl ClaudeHookState {
    pub fn snapshot(&self) -> Vec<SessionRecord> {
        match self.sessions.lock() {
            Ok(g) => g.values().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// JSON shape forwarded by the hook script. Optional fields gracefully
/// fall back to empty strings so a missing field never crashes parse.
#[derive(Debug, Deserialize)]
struct HookEnvelope {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    tool: String,
    /// Sub-classifier for events whose meaning depends on a secondary
    /// payload field. Today only `Notification` uses it (its
    /// `notification_type` field — `idle_prompt`, `permission_prompt`,
    /// `elicitation_dialog`, …); everything else passes empty.
    #[serde(default)]
    aux: String,
}

/// Map a Claude Code hook event name to one of our five status
/// buckets. Mirrors the actual Claude Code hook semantics as
/// documented (verified against code.claude.com/docs/en/hooks):
///
///   * Working = model is actively producing output / running tools.
///     `UserPromptSubmit` (turn starts), `PreToolUse` / `PostToolUse`
///     (mid-turn tool calls), `PostToolUseFailure` (recovery in
///     progress), `SubagentStart` (sub-agent producing output too).
///
///   * Compacting = context window is being summarized.
///     `PreCompact` only — `PostCompact` is treated as Idle since
///     the work is done and the model is about to resume.
///
///   * Waiting = paused on user input. `PermissionRequest` (blocking
///     dialog open) and `Notification[permission_prompt]` (heads-up
///     before the dialog).
///
///   * Idle = model finished a turn and is sitting at its prompt
///     awaiting the next user message. `Stop`, `SubagentStop`,
///     `Notification[idle_prompt]`, `SessionStart`, `PostCompact`.
///     `Notification[idle_prompt]` is the documented "Claude is done
///     and waiting" signal — important because `Stop` does NOT fire
///     on Ctrl+C interrupts, so `Notification` is the safety net.
///
///   * Ended = `SessionEnd` only; evicts the session from the map.
///
/// `Notification` is dispatched separately because the meaning
/// depends on its `notification_type` payload field, not the event
/// name alone. The caller passes that field through here as `aux`.
fn classify_event(event: &str, aux: &str) -> Option<SessionStatus> {
    match event {
        "UserPromptSubmit"
        | "PreToolUse"
        | "PostToolUse"
        | "PostToolUseFailure"
        | "PostToolBatch"
        | "SubagentStart" => Some(SessionStatus::Working),

        "PreCompact" => Some(SessionStatus::Compacting),

        "PermissionRequest" => Some(SessionStatus::Waiting),

        "Notification" => match aux {
            "permission_prompt" => Some(SessionStatus::Waiting),
            "idle_prompt" => Some(SessionStatus::Idle),
            // Other notification_types (elicitation_dialog,
            // auth_success, etc.) don't change spinner state.
            _ => None,
        },

        "Stop" | "SubagentStop" => Some(SessionStatus::Idle),
        "SessionStart" | "PostCompact" => Some(SessionStatus::Idle),

        "SessionEnd" => Some(SessionStatus::Ended),

        _ => None,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn the Unix-socket listener. Runs on a dedicated OS thread that
/// blocks on `accept()`; each connection is short-lived (one JSON
/// payload, then close), so a single accept loop is more than fast
/// enough — Claude Code only fires hooks a few times per second.
pub fn start_socket_server(app: AppHandle<Wry>) {
    // Clean up stale socket from a crashed previous run. `bind` will
    // fail with EADDRINUSE otherwise even when the prior listener is
    // gone.
    let _ = fs::remove_file(SOCKET_PATH);

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("gli claude hook socket bind failed: {e}");
            return;
        }
    };

    // 0600 — only the running user can write. Matches Notchi's hardening.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(SOCKET_PATH) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(SOCKET_PATH, perms);
        }
    }

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            // Handle each connection inline — payload is tiny and the
            // socket is private. Spawning per-connection threads would
            // be over-engineering for at most a few events/sec.
            handle_connection(stream, &app);
        }
    });
}

fn handle_connection(mut stream: UnixStream, app: &AppHandle<Wry>) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = Vec::with_capacity(2048);
    if let Err(e) = stream.read_to_end(&mut buf) {
        eprintln!("[gli-hooks] socket read failed: {e}");
        return;
    }
    let envelope: HookEnvelope = match serde_json::from_slice(&buf) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[gli-hooks] decode failed: {e}; raw={}",
                String::from_utf8_lossy(&buf)
            );
            return;
        }
    };
    if envelope.session_id.is_empty() {
        eprintln!("[gli-hooks] dropping event with empty session_id");
        return;
    }
    let Some(status) = classify_event(&envelope.event, &envelope.aux) else {
        eprintln!(
            "[gli-hooks] unrecognized event '{}' (aux='{}'); ignoring",
            envelope.event, envelope.aux
        );
        return;
    };
    eprintln!(
        "[gli-hooks] event={}{} status={:?} cwd={} session={}",
        envelope.event,
        if envelope.aux.is_empty() {
            String::new()
        } else {
            format!("[{}]", envelope.aux)
        },
        status,
        envelope.cwd,
        envelope.session_id
    );

    let state = match app.try_state::<ClaudeHookState>() {
        Some(s) => s,
        None => return,
    };

    let record = {
        let mut sessions = match state.sessions.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        // SessionEnd evicts so a long-lived app doesn't accumulate
        // dead sessions in the map.
        if status == SessionStatus::Ended {
            sessions.remove(&envelope.session_id);
            SessionRecord {
                session_id: envelope.session_id.clone(),
                cwd: envelope.cwd.clone(),
                status,
                last_event: envelope.event.clone(),
                last_tool: envelope.tool.clone(),
                updated_at_ms: now_ms(),
            }
        } else {
            let entry = sessions
                .entry(envelope.session_id.clone())
                .or_insert(SessionRecord {
                    session_id: envelope.session_id.clone(),
                    cwd: envelope.cwd.clone(),
                    status,
                    last_event: envelope.event.clone(),
                    last_tool: envelope.tool.clone(),
                    updated_at_ms: now_ms(),
                });
            entry.cwd = envelope.cwd.clone();
            entry.status = status;
            entry.last_event = envelope.event.clone();
            if !envelope.tool.is_empty() {
                entry.last_tool = envelope.tool.clone();
            }
            entry.updated_at_ms = now_ms();
            entry.clone()
        }
    };

    let _ = app.emit(SESSION_STATE_EVENT, &record);
}

/// Tauri command — return the current snapshot of all known Claude
/// sessions. The frontend calls this once on boot to hydrate its store,
/// then relies on `SESSION_STATE_EVENT` for live updates.
#[tauri::command]
pub fn claude_sessions(
    state: tauri::State<ClaudeHookState>,
) -> Vec<SessionRecord> {
    state.snapshot()
}

/* ------------------------------------------------------------------
   Hook installer
   ------------------------------------------------------------------ */

fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// One-shot install: write the script to `~/.claude/hooks/`, upsert the
/// settings.json entries, log every step. Designed to be invoked
/// unconditionally on every app launch — idempotent.
///
/// Logging matters here because the only way the spinner can silently
/// not work is if the hook script never gets called by Claude. Without
/// console traces of "wrote script to X / merged settings into Y" the
/// user would have no way to know whether the failure is on the install
/// side or the runtime side.
pub fn install_hooks() {
    let Some(claude) = claude_dir() else {
        eprintln!("[gli-hooks] no home dir; skipping install");
        return;
    };
    // Create `~/.claude/` if it doesn't exist yet. Claude Code's
    // installer creates this dir lazily on first run, so a freshly
    // installed Claude that hasn't been launched yet will be missing
    // it. Creating it ourselves means our hooks land in the right
    // place the moment Claude is invoked.
    if let Err(e) = fs::create_dir_all(&claude) {
        eprintln!("[gli-hooks] mkdir {} failed: {e}", claude.display());
        return;
    }

    let hooks_dir = claude.join("hooks");
    if let Err(e) = fs::create_dir_all(&hooks_dir) {
        eprintln!("[gli-hooks] mkdir hooks failed: {e}");
        return;
    }
    let script_path = hooks_dir.join("gli-claude-hook.sh");
    if let Err(e) = fs::write(&script_path, HOOK_SCRIPT) {
        eprintln!("[gli-hooks] write script failed: {e}");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&script_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&script_path, perms);
        }
    }
    eprintln!("[gli-hooks] wrote {}", script_path.display());

    let settings_path = claude.join("settings.json");
    let existing: Value = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let updated = upsert_hook_entries(existing);
    match serde_json::to_string_pretty(&updated) {
        Ok(serialized) => match fs::write(&settings_path, &serialized) {
            Ok(()) => eprintln!(
                "[gli-hooks] merged hook entries into {}",
                settings_path.display()
            ),
            Err(e) => eprintln!("[gli-hooks] write settings failed: {e}"),
        },
        Err(e) => eprintln!("[gli-hooks] serialize settings failed: {e}"),
    }
}

/// Merge our hook entries into the provided settings JSON. Preserves
/// any existing hooks (the user's own or other tools') by appending
/// rather than replacing the per-event arrays. Idempotent on repeat
/// invocations — checks for an existing entry whose command contains
/// `gli-claude-hook.sh` and refreshes the command string in place
/// instead of duplicating.
fn upsert_hook_entries(mut root: Value) -> Value {
    let command =
        "\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/gli-claude-hook.sh\"";

    // Each tuple = (event name, matcher config). Most events use no
    // matcher; PreToolUse / PostToolUse / PermissionRequest scope to
    // any tool (matcher "*"); PreCompact registers both auto + manual.
    let hook_entry = json!([{"type": "command", "command": command}]);
    let with_matcher = json!([{"matcher": "*", "hooks": hook_entry}]);
    let without_matcher = json!([{"hooks": hook_entry}]);
    let pre_compact = json!([
        {"matcher": "auto", "hooks": hook_entry},
        {"matcher": "manual", "hooks": hook_entry}
    ]);

    let events: &[(&str, &Value)] = &[
        ("UserPromptSubmit", &without_matcher),
        ("SessionStart", &without_matcher),
        ("PreToolUse", &with_matcher),
        ("PostToolUse", &with_matcher),
        ("PermissionRequest", &with_matcher),
        // Notification is the safety net for cases Stop doesn't cover —
        // most importantly Ctrl+C interrupts. `notification_type:
        // idle_prompt` fires when Claude is sitting at its prompt
        // waiting for the next user message, even when Stop never
        // arrived.
        ("Notification", &without_matcher),
        ("PreCompact", &pre_compact),
        ("PostCompact", &pre_compact),
        ("Stop", &without_matcher),
        ("SubagentStop", &without_matcher),
        ("SessionEnd", &without_matcher),
    ];

    if !root.is_object() {
        root = json!({});
    }
    let root_obj = root.as_object_mut().expect("just made object");

    let hooks_value = root_obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks_value.is_object() {
        *hooks_value = json!({});
    }
    let hooks_obj = hooks_value.as_object_mut().expect("just made object");

    for (event, config) in events {
        let entry = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let arr = entry.as_array_mut().expect("just made array");

        // Refresh-or-append. If we find an entry whose `hooks[].command`
        // points to gli-claude-hook.sh, leave it alone (already
        // installed). Otherwise append our config.
        let mut found = false;
        for item in arr.iter() {
            let Some(inner_hooks) =
                item.get("hooks").and_then(|h| h.as_array())
            else {
                continue;
            };
            for inner in inner_hooks {
                let cmd = inner
                    .get("command")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                if cmd.contains("gli-claude-hook.sh") {
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
        if !found {
            if let Value::Array(extras) = (*config).clone() {
                for x in extras {
                    arr.push(x);
                }
            }
        }
    }

    root
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_known_events() {
        assert_eq!(
            classify_event("UserPromptSubmit", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_event("PreToolUse", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_event("PostToolUse", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_event("SubagentStart", ""),
            Some(SessionStatus::Working)
        );
        assert_eq!(
            classify_event("PreCompact", ""),
            Some(SessionStatus::Compacting)
        );
        assert_eq!(
            classify_event("PermissionRequest", ""),
            Some(SessionStatus::Waiting)
        );
        // Stop / SubagentStop → Idle, NOT Waiting. The agent finished
        // a turn and is sitting at its input box for the next user
        // prompt — there's no pending tool to resume from.
        assert_eq!(classify_event("Stop", ""), Some(SessionStatus::Idle));
        assert_eq!(
            classify_event("SubagentStop", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_event("SessionStart", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_event("PostCompact", ""),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_event("SessionEnd", ""),
            Some(SessionStatus::Ended)
        );
        assert_eq!(classify_event("UnknownEvent", ""), None);
    }

    #[test]
    fn classify_notification_by_type() {
        // Notification's meaning depends on its `notification_type`.
        // idle_prompt = Claude waiting for next user prompt (the
        // documented safety net for "Stop didn't fire" — Ctrl+C).
        // permission_prompt = heads-up before a permission dialog.
        // Other types don't affect spinner state.
        assert_eq!(
            classify_event("Notification", "idle_prompt"),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            classify_event("Notification", "permission_prompt"),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(classify_event("Notification", "elicitation_dialog"), None);
        assert_eq!(classify_event("Notification", "auth_success"), None);
        assert_eq!(classify_event("Notification", ""), None);
    }

    #[test]
    fn upsert_into_empty_settings() {
        let out = upsert_hook_entries(json!({}));
        let hooks = out.get("hooks").and_then(|h| h.as_object()).unwrap();
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("Stop"));
        assert!(hooks.contains_key("PreCompact"));
        // PreCompact gets two matcher entries.
        let pc = hooks.get("PreCompact").and_then(|v| v.as_array()).unwrap();
        assert_eq!(pc.len(), 2);
    }

    #[test]
    fn upsert_is_idempotent_on_re_install() {
        let once = upsert_hook_entries(json!({}));
        let twice = upsert_hook_entries(once.clone());
        assert_eq!(once, twice);
    }

    #[test]
    fn upsert_preserves_unrelated_user_hooks() {
        let user = json!({
            "hooks": {
                "Stop": [
                    {"hooks": [{"type": "command", "command": "echo done"}]}
                ]
            },
            "somethingElse": "untouched"
        });
        let out = upsert_hook_entries(user);
        assert_eq!(out.get("somethingElse").and_then(|v| v.as_str()), Some("untouched"));
        let stop = out
            .get("hooks")
            .and_then(|h| h.get("Stop"))
            .and_then(|v| v.as_array())
            .unwrap();
        // User's echo + our gli entry.
        assert_eq!(stop.len(), 2);
    }

    #[test]
    fn running_states_classification() {
        assert!(SessionStatus::Working.is_running());
        assert!(SessionStatus::Compacting.is_running());
        assert!(!SessionStatus::Waiting.is_running());
        assert!(!SessionStatus::Ended.is_running());
    }
}
