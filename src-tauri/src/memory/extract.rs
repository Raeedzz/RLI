//! Mem0-style fact extraction from a transcript or conversation snippet.
//!
//! Manual-only in v1 — invoked via `POST /memory/extract` from the
//! `rli-memory extract <file>` CLI. The route returns extracted facts
//! to the caller; storage is the caller's choice. This keeps Gemini API
//! spend predictable (no surprise calls on every closed PTY block).
//!
//! Returned facts are atomic statements ≤80 chars each, intended to be
//! fed back into `/memory/add` (with dedupe-on-add) one at a time.
use tauri::State;

use crate::gemini::{generate_text, GeminiState};

const SYSTEM: &str = "You distill developer transcripts into atomic project facts. \
Return ONE fact per line, no bullets, no numbering, no preamble. \
Each fact must be a single concrete statement under 80 characters. \
Skip command outputs; only emit project-level conclusions worth remembering.";

const MAX_TOKENS: u32 = 256;
const TEMPERATURE: f32 = 0.2;

/// Run the transcript through Flash-Lite and parse the response into a
/// `Vec<String>` of atomic facts. Lines longer than 80 chars are kept
/// (the prompt is a soft constraint) but each fact is trimmed and
/// deduped against the same response (case-insensitive).
pub async fn extract_facts(
    transcript: &str,
    gemini: &State<'_, GeminiState>,
) -> Result<Vec<String>, String> {
    if transcript.trim().is_empty() {
        return Ok(Vec::new());
    }

    let prompt = format!(
        "Transcript:\n---\n{}\n---\n\nFacts:",
        // Cap the prompt size so a 200KB transcript doesn't burn the
        // model's context. Flash-Lite's 1M ctx is plenty in theory but
        // we don't need it; recent context is more relevant anyway.
        truncate_tail(transcript, 16_000)
    );

    let raw = generate_text(
        gemini,
        &prompt,
        Some(SYSTEM),
        Some(MAX_TOKENS),
        Some(TEMPERATURE),
    )
    .await?;

    Ok(parse_facts(&raw))
}

/// Keep only the LAST `max_chars` of the input. Drops a leading
/// partial line so the truncated head reads as "starts mid-line"
/// rather than splitting a word.
fn truncate_tail(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        return s;
    }
    let start = s.len() - max_chars;
    // Snap forward to the next newline so we don't open mid-word.
    if let Some(nl) = s[start..].find('\n') {
        &s[start + nl + 1..]
    } else {
        &s[start..]
    }
}

/// Newline-split → trim → drop empties → drop bullet/number prefixes
/// the model occasionally emits despite the system prompt → dedupe
/// case-insensitively while preserving order.
pub(crate) fn parse_facts(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out = Vec::new();
    for line in raw.lines() {
        let cleaned = strip_bullet(line.trim());
        if cleaned.is_empty() {
            continue;
        }
        let key = cleaned.to_lowercase();
        if seen.insert(key) {
            out.push(cleaned.to_string());
        }
    }
    out
}

fn strip_bullet(s: &str) -> &str {
    // Leading "- ", "* ", "• ", "1. ", "1) ".
    let trimmed = s.trim_start();
    if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
        return rest.trim();
    }
    if let Some(rest) = trimmed.strip_prefix("• ") {
        return rest.trim();
    }
    // Numbered: "1. " or "1) " or "12. " etc.
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i + 1 < bytes.len() && (bytes[i] == b'.' || bytes[i] == b')') && bytes[i + 1] == b' ' {
        return trimmed[i + 2..].trim();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_strips_bullets_and_dedupes() {
        let raw = "- we use bun, not npm\n* we use bun, not npm\n1. auth tokens are 32 bytes\n2) build runs in 2.3s\n\n• server on port 3000";
        let facts = parse_facts(raw);
        assert_eq!(facts.len(), 4);
        assert_eq!(facts[0], "we use bun, not npm");
        assert_eq!(facts[1], "auth tokens are 32 bytes");
        assert_eq!(facts[2], "build runs in 2.3s");
        assert_eq!(facts[3], "server on port 3000");
    }

    #[test]
    fn parse_handles_empty() {
        assert!(parse_facts("").is_empty());
        assert!(parse_facts("\n\n  \n").is_empty());
    }

    #[test]
    fn truncate_keeps_tail_after_newline() {
        let s = "line1\nline2\nline3\nline4\n";
        let t = truncate_tail(s, 12);
        assert!(t.ends_with("line4\n"));
        assert!(!t.contains("line1"));
    }
}
