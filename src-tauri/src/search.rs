//! Search backend for RLI.
//!
//! Two engines: `rg` (text search, literal or regex) and `ast-grep` /
//! `sg` (structural / AST-aware search). Both are external binaries
//! shelled out — they're best-in-class at what they do and writing
//! Rust replacements for either would be a year of work.
//!
//! Pre-flight: if the binary isn't on PATH we return a structured
//! error so the frontend can surface a helpful "brew install ripgrep"
//! hint instead of a stack trace.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

fn ensure_cwd(cwd: &str) -> Result<(), String> {
    if !Path::new(cwd).exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    Ok(())
}

/// Find the bundled ripgrep sidecar binary. In a packaged macOS app it
/// lives at Contents/MacOS/rg-<target-triple>; in dev it's under
/// `target/<profile>/rg-<target-triple>`. We let Tauri's path resolver
/// hand us the directory containing the main executable, then look for
/// the binary there. Returns None when the binary isn't present so the
/// caller can fall back to the system PATH copy of `rg`.
fn resolve_rg_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe_dir = app.path().resolve("", tauri::path::BaseDirectory::Resource).ok()
        .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())))?;
    let target_triple = current_target_triple();
    let candidate = exe_dir.join(format!("rg-{target_triple}"));
    if candidate.is_file() {
        return Some(candidate);
    }
    // Dev mode fallback: the binary lives in src-tauri/binaries before
    // it's been bundled into the resource dir.
    let dev = std::env::current_exe().ok()?;
    let dev_root = dev.ancestors().nth(3)?; // target/<profile>/<exe> → project root
    let dev_candidate = dev_root.join("binaries").join(format!("rg-{target_triple}"));
    if dev_candidate.is_file() {
        return Some(dev_candidate);
    }
    None
}

fn current_target_triple() -> &'static str {
    // Built into the binary at compile time. Match Cargo's target triples
    // for the platforms RLI ships on.
    if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_arch = "aarch64", target_os = "linux")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

/* ------------------------------------------------------------------
   ripgrep
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn search_rg(
    app: tauri::AppHandle,
    cwd: String,
    query: String,
    regex: bool,
) -> Result<Vec<SearchHit>, String> {
    ensure_cwd(&cwd)?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Resolve the bundled sidecar binary first (placed next to the
    // app executable in prod, under target/<profile>/ in dev). Fall
    // back to whatever `rg` is on PATH if the sidecar can't be found —
    // useful in dev before `scripts/download-rg.sh` has been run.
    let program: PathBuf = resolve_rg_binary(&app).unwrap_or_else(|| PathBuf::from("rg"));

    let mut cmd = Command::new(&program);
    cmd.arg("--json")
        .arg("--max-count=200")
        .arg("--smart-case");
    if !regex {
        cmd.arg("--fixed-strings");
    }
    cmd.arg("--").arg(&query).current_dir(&cwd);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn rg ({}): {e}", program.display()))?;

    // rg exits 1 on no matches, 0 on matches. Either way stdout has results.
    if !out.status.success() && out.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("rg failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_rg_json(&stdout))
}

#[derive(Deserialize)]
struct RgEvent {
    #[serde(rename = "type")]
    ty: String,
    data: Option<serde_json::Value>,
}

fn parse_rg_json(stdout: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<RgEvent>(line) else {
            continue;
        };
        if event.ty != "match" {
            continue;
        }
        let Some(data) = event.data else { continue };
        let path = data
            .pointer("/path/text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let line_no = data
            .get("line_number")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let text = data
            .pointer("/lines/text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim_end_matches('\n').to_string())
            .unwrap_or_default();
        let column = data
            .get("submatches")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|m| m.get("start"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        if let Some(path) = path {
            hits.push(SearchHit {
                path,
                line: line_no,
                column: column + 1,
                text,
            });
        }
    }
    hits
}

/* ------------------------------------------------------------------
   ast-grep / sg
   ------------------------------------------------------------------ */

#[tauri::command]
pub async fn search_ast_grep(
    cwd: String,
    pattern: String,
    lang: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    ensure_cwd(&cwd)?;
    if pattern.trim().is_empty() {
        return Ok(Vec::new());
    }

    // ast-grep ships its CLI as either `sg` or `ast-grep` depending on the
    // installer. Try `sg` first, fall back to `ast-grep`.
    let bin = if which("sg") {
        "sg"
    } else if which("ast-grep") {
        "ast-grep"
    } else {
        return Err(
            "ast-grep not installed. `brew install ast-grep` or `npm i -g @ast-grep/cli`."
                .into(),
        );
    };

    let mut cmd = Command::new(bin);
    cmd.arg("run")
        .arg("--pattern")
        .arg(&pattern)
        .arg("--json=stream");
    if let Some(l) = lang.as_deref() {
        cmd.arg("--lang").arg(l);
    }
    cmd.current_dir(&cwd);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn {bin}: {e}"))?;

    if !out.status.success() && out.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ast-grep failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_sg_json(&stdout))
}

fn parse_sg_json(stdout: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let path = value
            .get("file")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let line_no = value
            .pointer("/range/start/line")
            .and_then(|v| v.as_u64())
            .map(|n| (n + 1) as u32) // sg is 0-indexed
            .unwrap_or(0);
        let column = value
            .pointer("/range/start/column")
            .and_then(|v| v.as_u64())
            .map(|n| (n + 1) as u32)
            .unwrap_or(1);
        let text = value
            .get("lines")
            .and_then(|v| v.as_str())
            .map(|s| s.trim_end_matches('\n').to_string())
            .or_else(|| {
                value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();

        if let Some(path) = path {
            hits.push(SearchHit {
                path,
                line: line_no,
                column,
                text,
            });
        }
    }
    hits
}

fn which(bin: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    for dir in path.split(':') {
        let full = Path::new(dir).join(bin);
        if full.is_file() {
            return true;
        }
    }
    false
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- ripgrep parser ---------- */

    #[test]
    fn rg_empty_input_returns_no_hits() {
        assert!(parse_rg_json("").is_empty());
    }

    #[test]
    fn rg_parses_a_single_match_line() {
        let raw = r#"{"type":"match","data":{"path":{"text":"src/main.rs"},"lines":{"text":"fn main() {\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"main"},"start":3,"end":7}]}}"#;
        let hits = parse_rg_json(raw);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.path, "src/main.rs");
        assert_eq!(h.line, 1);
        // submatch start=3, parser returns 1-indexed column
        assert_eq!(h.column, 4);
        assert_eq!(h.text, "fn main() {");
    }

    #[test]
    fn rg_ignores_begin_and_end_events() {
        let raw = "{\"type\":\"begin\",\"data\":{\"path\":{\"text\":\"src/main.rs\"}}}\n\
                   {\"type\":\"end\",\"data\":{\"path\":{\"text\":\"src/main.rs\"}}}\n\
                   {\"type\":\"summary\",\"data\":{}}\n";
        let hits = parse_rg_json(raw);
        assert!(hits.is_empty());
    }

    #[test]
    fn rg_skips_malformed_json_lines() {
        let raw = "not json at all\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"a.rs\"},\"lines\":{\"text\":\"x\"},\"line_number\":7,\"submatches\":[{\"match\":{\"text\":\"x\"},\"start\":0,\"end\":1}]}}\n\
                   {bad}\n";
        let hits = parse_rg_json(raw);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.rs");
        assert_eq!(hits[0].line, 7);
    }

    #[test]
    fn rg_preserves_match_order_across_multiple_files() {
        let raw = "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"a.rs\"},\"lines\":{\"text\":\"foo\"},\"line_number\":1,\"submatches\":[{\"start\":0,\"end\":3}]}}\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"b.rs\"},\"lines\":{\"text\":\"bar foo\"},\"line_number\":12,\"submatches\":[{\"start\":4,\"end\":7}]}}\n";
        let hits = parse_rg_json(raw);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a.rs");
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[1].path, "b.rs");
        assert_eq!(hits[1].line, 12);
        assert_eq!(hits[1].column, 5);
    }

    #[test]
    fn rg_strips_trailing_newline_from_text() {
        let raw = r#"{"type":"match","data":{"path":{"text":"x"},"lines":{"text":"hello\n"},"line_number":1,"submatches":[{"start":0,"end":5}]}}"#;
        let hits = parse_rg_json(raw);
        assert_eq!(hits[0].text, "hello");
    }

    #[test]
    fn rg_match_without_submatches_defaults_column_to_one() {
        let raw = r#"{"type":"match","data":{"path":{"text":"x"},"lines":{"text":"line"},"line_number":4,"submatches":[]}}"#;
        let hits = parse_rg_json(raw);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].column, 1);
    }

    /* ---------- ast-grep parser ---------- */

    #[test]
    fn sg_empty_input_returns_no_hits() {
        assert!(parse_sg_json("").is_empty());
    }

    #[test]
    fn sg_parses_a_single_match() {
        // sg uses 0-indexed line/column; the parser bumps to 1-indexed.
        let raw = r#"{"text":"console.log","file":"app.ts","lines":"  console.log(x);","range":{"start":{"line":4,"column":2},"end":{"line":4,"column":13}}}"#;
        let hits = parse_sg_json(raw);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.path, "app.ts");
        assert_eq!(h.line, 5); // 0-indexed → 1-indexed
        assert_eq!(h.column, 3); // 0-indexed → 1-indexed
        assert_eq!(h.text, "  console.log(x);");
    }

    #[test]
    fn sg_falls_back_from_lines_to_text() {
        let raw = r#"{"text":"snippet only","file":"x.rs","range":{"start":{"line":0,"column":0},"end":{"line":0,"column":1}}}"#;
        let hits = parse_sg_json(raw);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "snippet only");
    }

    #[test]
    fn sg_skips_lines_without_a_file_field() {
        // Without "file", the entry is dropped — there's nothing useful to surface.
        let raw = r#"{"text":"x","range":{"start":{"line":0,"column":0},"end":{"line":0,"column":1}}}"#;
        assert!(parse_sg_json(raw).is_empty());
    }

    #[test]
    fn sg_skips_malformed_json_lines() {
        let raw = "garbage\n\
                   {\"file\":\"a.rs\",\"text\":\"hit\",\"range\":{\"start\":{\"line\":0,\"column\":0}}}\n";
        let hits = parse_sg_json(raw);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.rs");
    }

    #[test]
    fn sg_multi_line_stream_preserves_order() {
        let raw = "{\"file\":\"a\",\"text\":\"x\",\"range\":{\"start\":{\"line\":0,\"column\":0}}}\n\
                   {\"file\":\"b\",\"text\":\"y\",\"range\":{\"start\":{\"line\":3,\"column\":2}}}\n";
        let hits = parse_sg_json(raw);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a");
        assert_eq!(hits[1].path, "b");
        assert_eq!(hits[1].line, 4);
        assert_eq!(hits[1].column, 3);
    }
}
