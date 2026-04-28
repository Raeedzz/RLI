//! Real Claude usage scanner — reads Claude Code's own transcript files
//! at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` and
//! aggregates token counts within the rolling 5-hour usage window.
//!
//! This replaces the previous PTY-banner-sniff heuristic, which only
//! knew "claude was launched at time X in this pane" — useless for
//! actual rate-limit budgeting because:
//!
//!   - it didn't see usage from claude sessions launched outside RLI
//!   - it didn't reset on a real window roll-over (5h after first msg)
//!   - it had no token visibility at all
//!
//! Schema (one JSON per line, append-only). The fields we care about:
//!
//! ```json
//! {
//!   "type": "assistant",
//!   "timestamp": "2026-04-28T01:16:32.435Z",
//!   "message": {
//!     "model": "claude-opus-4-7",
//!     "usage": {
//!       "input_tokens": 6,
//!       "output_tokens": 190,
//!       "cache_read_input_tokens": 14779,
//!       "cache_creation_input_tokens": 14181
//!     }
//!   }
//! }
//! ```
//!
//! User messages don't carry usage; we only count `assistant` rows.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Anthropic's enforced 5-hour session length. A "session" in
/// Claude.ai's UI = a 5h timer that starts on your first message after
/// the previous session expired. We mirror that: walk messages
/// chronologically, restart the session anchor whenever 5h has elapsed
/// since the current anchor.
const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;

/// We need to look back far enough to find the boundary BEFORE the
/// current session — i.e. up to 5h of in-session messages plus a
/// generous gap for the previous session. 12h is enough to anchor
/// any current session correctly even if the user has been active
/// continuously for hours.
const LOOKBACK_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Default, Serialize, Clone)]
pub struct ModelBreakdown {
    pub messages: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct ClaudeUsageStatus {
    /// True when at least one assistant message was found in the
    /// window. When false the pill should be hidden.
    pub active: bool,
    /// Wall-clock millis of the OLDEST message in the current window
    /// (anchors the 5-hour countdown). `None` when `active = false`.
    pub window_start_ms: Option<i64>,
    /// `window_start_ms + 5h`. Reset time. `None` when `active = false`.
    pub window_ends_ms: Option<i64>,
    pub message_count: u32,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    /// Per-model aggregates. Keyed by the model id Claude wrote into
    /// the transcript (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`).
    pub by_model: HashMap<String, ModelBreakdown>,
    /// How many transcript files we actually opened. Used for the
    /// frontend's "scanned N sessions" hint and for diagnosing empty
    /// readings (no projects, permissions issues).
    pub scanned_files: u32,
    /// EXACT 5-hour usage percent reported by Anthropic (0-100), via
    /// the `rate_limits.five_hour.used_percentage` field that Claude
    /// Code feeds to its status-line hook. `None` when the user
    /// hasn't installed RLI's status-line capture script (in which
    /// case the frontend falls back to a calibrated estimate against
    /// transcript token counts).
    pub real_five_hour_percent: Option<f32>,
    /// EXACT 7-day usage percent. Same provenance as above.
    pub real_seven_day_percent: Option<f32>,
    /// Real reset wall-clock millis for the 5h window, when available.
    pub real_five_hour_resets_ms: Option<i64>,
    /// When the rli-usage-capture.sh hook last wrote the cache file,
    /// in epoch millis. Used by the frontend to age out stale data.
    pub real_captured_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CapturedRateLimit {
    used_percentage: Option<f32>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CapturedRateLimits {
    five_hour: Option<CapturedRateLimit>,
    seven_day: Option<CapturedRateLimit>,
}

#[derive(Debug, Deserialize)]
struct CapturedUsage {
    rate_limits: Option<CapturedRateLimits>,
    captured_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TranscriptLine {
    #[serde(default, rename = "type")]
    line_type: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<MessagePayload>,
}

#[derive(Debug, Deserialize)]
struct MessagePayload {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<UsageBlock>,
}

#[derive(Debug, Deserialize, Default)]
struct UsageBlock {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
}

/// One assistant message worth of usage data, retained as a flat row
/// so we can sort them across files before walking session boundaries.
#[derive(Debug, Clone)]
struct UsageRow {
    ts_ms: i64,
    model: Option<String>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

#[tauri::command]
pub fn claude_usage_status() -> Result<ClaudeUsageStatus, String> {
    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    };
    let lookback_cutoff_ms = now_ms - LOOKBACK_MS;

    let projects_dir = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Ok(ClaudeUsageStatus::default()),
    };
    if !projects_dir.exists() {
        // Claude Code never installed. Empty status — pill stays hidden.
        return Ok(ClaudeUsageStatus::default());
    }

    let files = collect_transcript_files(&projects_dir, lookback_cutoff_ms);
    let mut status = ClaudeUsageStatus::default();
    let mut rows: Vec<UsageRow> = Vec::new();

    for path in &files {
        status.scanned_files += 1;
        let Ok(file) = File::open(path) else { continue };
        let reader = BufReader::new(file);
        for line in reader.lines() {
            let Ok(raw) = line else { continue };
            if raw.is_empty() {
                continue;
            }
            // Each line is JSON; bad lines are skipped silently —
            // partial writes can happen at the tail of a live file.
            let parsed: TranscriptLine = match serde_json::from_str(&raw) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if parsed.line_type != "assistant" {
                continue;
            }
            let Some(ts_iso) = parsed.timestamp.as_deref() else {
                continue;
            };
            let ts_ms = match parse_iso_to_ms(ts_iso) {
                Some(t) => t,
                None => continue,
            };
            if ts_ms < lookback_cutoff_ms {
                continue;
            }
            let Some(msg) = parsed.message else { continue };
            let Some(usage) = msg.usage else { continue };

            let input = usage.input_tokens.unwrap_or(0);
            let output = usage.output_tokens.unwrap_or(0);
            let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
            let cache_creation = usage.cache_creation_input_tokens.unwrap_or(0);

            // Skip empty-usage entries (some transcript variants emit
            // partial assistant rows during streaming; the final row
            // for the same message id has the real numbers).
            if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                continue;
            }

            rows.push(UsageRow {
                ts_ms,
                model: msg.model,
                input,
                output,
                cache_read,
                cache_creation,
            });
        }
    }

    if rows.is_empty() {
        return Ok(status);
    }

    // Walk chronologically and find the start of the CURRENT session.
    // Anthropic's "session" is a 5h timer anchored on the first message
    // after the previous session expired. So we scan forward, and each
    // time the next message lands more than 5h after the current
    // session anchor, we treat that message as a new anchor.
    rows.sort_by_key(|r| r.ts_ms);
    let mut session_start_ms = rows[0].ts_ms;
    for r in &rows {
        if r.ts_ms - session_start_ms > WINDOW_MS {
            session_start_ms = r.ts_ms;
        }
    }

    // Aggregate ONLY rows in the current session: ts >= session_start
    // AND ts < session_start + 5h. (Future-dated rows shouldn't exist
    // but we guard the upper bound for safety.)
    let session_end_ms = session_start_ms + WINDOW_MS;
    for r in rows.iter().filter(|r| r.ts_ms >= session_start_ms && r.ts_ms < session_end_ms) {
        status.message_count += 1;
        status.total_input_tokens += r.input;
        status.total_output_tokens += r.output;
        status.total_cache_read_tokens += r.cache_read;
        status.total_cache_creation_tokens += r.cache_creation;
        if let Some(model) = &r.model {
            let entry = status.by_model.entry(model.clone()).or_default();
            entry.messages += 1;
            entry.input_tokens += r.input;
            entry.output_tokens += r.output;
            entry.cache_read_tokens += r.cache_read;
            entry.cache_creation_tokens += r.cache_creation;
        }
    }

    if status.message_count > 0 {
        status.active = true;
        status.window_start_ms = Some(session_start_ms);
        status.window_ends_ms = Some(session_end_ms);
    }

    // Layer in the REAL rate-limit numbers when the user has installed
    // the status-line capture hook. These come straight from Anthropic
    // (Claude Code feeds them to the statusLine command), so they
    // exactly match what claude.ai's settings page shows.
    if let Some(home) = dirs::home_dir() {
        let cache = home.join(".claude").join("cache").join("rli-usage.json");
        if let Ok(bytes) = fs::read(&cache) {
            if let Ok(c) = serde_json::from_slice::<CapturedUsage>(&bytes) {
                status.real_captured_at_ms = c.captured_at_ms;
                if let Some(rl) = c.rate_limits {
                    if let Some(fh) = rl.five_hour {
                        status.real_five_hour_percent = fh.used_percentage;
                        // resets_at is epoch SECONDS in the schema; convert.
                        status.real_five_hour_resets_ms = fh.resets_at.map(|s| s * 1000);
                    }
                    if let Some(sd) = rl.seven_day {
                        status.real_seven_day_percent = sd.used_percentage;
                    }
                }
                // If the real anchor is present, override the
                // transcript-derived window with it. The pill should
                // tick down to the actual reset time, not our guess.
                if let Some(resets_ms) = status.real_five_hour_resets_ms {
                    status.window_ends_ms = Some(resets_ms);
                    status.window_start_ms = Some(resets_ms - WINDOW_MS);
                    // We have data → pill should show even if no
                    // assistant messages happened to be in our scan
                    // (e.g. user just installed the capture hook).
                    status.active = true;
                }
            }
        }
    }

    Ok(status)
}

/// Walk `~/.claude/projects/<*>/<*>.jsonl` and return only files whose
/// mtime is within the window. Older sessions can't contribute to
/// "last 5h" usage, so skipping them avoids parsing megabytes of
/// historical transcripts on every poll.
fn collect_transcript_files(root: &PathBuf, cutoff_ms: i64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(top) = fs::read_dir(root) else {
        return out;
    };
    for entry in top.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Ok(inner) = fs::read_dir(&p) else { continue };
        for f in inner.flatten() {
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = f.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Ok(d) = mtime.duration_since(UNIX_EPOCH) {
                        if (d.as_millis() as i64) < cutoff_ms {
                            // File hasn't been touched in 5h — every
                            // assistant message inside is older than
                            // the window. Skip without opening.
                            continue;
                        }
                    }
                }
            }
            out.push(path);
        }
    }
    out
}

/// Convert an ISO-8601 UTC timestamp ("2026-04-28T01:16:32.435Z") to
/// epoch millis without pulling in `chrono`. Tolerant of either Z or
/// offset suffix; we strip non-digits manually after the date components.
fn parse_iso_to_ms(s: &str) -> Option<i64> {
    // Parse YYYY-MM-DDTHH:MM:SS.mmm
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    let millis: i64 = if bytes.len() >= 23 && bytes[19] == b'.' {
        s.get(20..23)?.parse().ok()?
    } else {
        0
    };
    let days = days_from_civil(year, month as u32, day as u32);
    let total_secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(total_secs * 1000 + millis)
}

/// Howard Hinnant's days_from_civil (Public Domain) — converts a UTC
/// Y-M-D to days since 1970-01-01. Avoids a chrono dependency for
/// what's essentially a flat ISO parse.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let m_adj = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * m_adj + 2) / 5 + (d as u64 - 1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_with_millis() {
        // 2026-04-28T01:16:32.435Z → 20571 days × 86400000 ms/day
        // + 4592s × 1000 + 435 = 1_777_338_992_435.
        let ms = parse_iso_to_ms("2026-04-28T01:16:32.435Z").unwrap();
        assert_eq!(ms, 1_777_338_992_435);
    }

    #[test]
    fn parses_iso_without_millis() {
        let ms = parse_iso_to_ms("2026-04-28T01:16:32Z").unwrap();
        assert_eq!(ms, 1_777_338_992_000);
    }

    #[test]
    fn epoch_zero_roundtrip() {
        // 1970-01-01T00:00:00Z is day 0 → ms 0. Anchors the math.
        assert_eq!(parse_iso_to_ms("1970-01-01T00:00:00Z").unwrap(), 0);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_iso_to_ms("not a date").is_none());
        assert!(parse_iso_to_ms("").is_none());
    }

    #[test]
    fn empty_state_when_no_projects_dir() {
        // We can't easily mock `~/.claude/projects` without a temp
        // env var indirection; this test just confirms the public
        // shape is sane. Real behaviour is exercised at runtime.
        let s = ClaudeUsageStatus::default();
        assert!(!s.active);
        assert_eq!(s.message_count, 0);
        assert_eq!(s.total_input_tokens, 0);
    }
}
