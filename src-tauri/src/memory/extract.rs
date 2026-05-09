//! Mem0-style fact extraction from a transcript or conversation snippet.
//!
//! Manual-only in v1 — invoked via `POST /memory/extract` from the
//! `rli-memory extract <file>` CLI. The route returns extracted facts
//! to the caller; storage is the caller's choice.
//!
//! Routes through whichever CLI agent (claude / codex / gemini) the
//! caller specifies — defaults to `claude` if none is given. The
//! daemon spawns the CLI as a one-shot subprocess via
//! {@link crate::helper_agent::run_inline}.
//!
//! Returned facts are atomic statements ≤80 chars each, intended to be
//! fed back into `/memory/add` (with dedupe-on-add) one at a time.

use crate::helper_agent::{run_inline, HelperMode};

const PROMPT_PREFIX: &str = "You distill developer transcripts into atomic project facts. \
Return ONE fact per line, no bullets, no numbering, no preamble. \
Each fact must be a single concrete statement under 80 characters. \
Skip command outputs; only emit project-level conclusions worth remembering.\n\nTranscript:\n---\n";

/// Extract facts from a transcript. `cli` selects which agent CLI to
/// shell out to; pass `"claude"` (or whichever the caller is using).
pub async fn extract_facts(
    transcript: &str,
    cli: &str,
) -> Result<Vec<String>, String> {
    if transcript.trim().is_empty() {
        return Ok(Vec::new());
    }
    let prompt = format!(
        "{}{}\n---\n\nFacts:",
        PROMPT_PREFIX,
        truncate_tail(transcript, 16_000)
    );
    let raw = run_inline("", cli, HelperMode::Summary, &prompt, None).await?;
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
