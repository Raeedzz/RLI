//! Search backend for RLI.
//!
//! Single engine: `rg` (text search, literal or regex), shelled out
//! as an external binary — best-in-class at what it does and writing
//! a Rust replacement would be a year of work.
//!
//! Pre-flight: if the binary isn't on PATH we return a structured
//! error so the frontend can surface a helpful "brew install ripgrep"
//! hint instead of a stack trace.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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

/// Find the bundled ripgrep sidecar binary.
///
/// **Bundled (.app)**: Tauri strips the target-triple suffix when
///   placing externalBins, so the binary ends up at
///   `Contents/MacOS/rg` next to the main `rli` executable.
/// **Dev (`tauri dev` / `cargo run`)**: not bundled — the file
///   downloaded by `scripts/download-rg.sh` lives at
///   `src-tauri/binaries/rg-<target-triple>`.
///
/// Returns `None` when neither exists, in which case the caller falls
/// back to whatever `rg` is on `PATH`.
fn resolve_rg_binary(_app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // Production: `Contents/MacOS/rg` (the suffix is stripped by the
    // bundler). Same name on Windows / Linux too — Tauri normalizes.
    let bundled = exe_dir.join(if cfg!(windows) { "rg.exe" } else { "rg" });
    if bundled.is_file() {
        return Some(bundled);
    }

    // Dev: target/<profile>/<exe> → walk up to the cargo project root,
    // then into `binaries/rg-<target>`.
    let target_triple = current_target_triple();
    if let Some(dev_root) = exe.ancestors().nth(3) {
        let dev_candidate = dev_root
            .join("binaries")
            .join(format!("rg-{target_triple}"));
        if dev_candidate.is_file() {
            return Some(dev_candidate);
        }
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

/// List every tracked + working-tree file under `cwd`, sorted by
/// relevance against `query`. Powers the file-picker mode in the
/// search overlay — opens to a list of files, fuzzy-filters as the
/// user types. We shell to `rg --files` rather than walking the FS
/// ourselves so all the same .gitignore / .ignore / hidden-file
/// rules the rest of the app respects apply here too without us
/// having to reimplement them.
#[tauri::command]
pub async fn search_files(
    app: tauri::AppHandle,
    cwd: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    ensure_cwd(&cwd)?;
    let program: PathBuf = resolve_rg_binary(&app).unwrap_or_else(|| PathBuf::from("rg"));
    let mut cmd = Command::new(&program);
    cmd.arg("--files")
        // Include dotfiles (`.gitignore`, `.env.example`, …) since
        // they're often what people are looking for. rg still respects
        // `.gitignore` so `.git/` and friends stay excluded.
        .arg("--hidden")
        // Excluded explicitly because `--hidden` would otherwise let
        // the .git/ tree leak through on shallow ignores.
        .arg("--glob")
        .arg("!.git/")
        .current_dir(&cwd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn rg --files ({}): {e}", program.display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("rg --files failed: {stderr}"));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut paths: Vec<String> = stdout
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let q = query.trim().to_lowercase();
    if !q.is_empty() {
        // Cheap fuzzy: split the query on whitespace; every token
        // must appear in the path (case-insensitive). Then rank by
        // a composite score — basename hits beat path-only hits,
        // an exact-substring beats scattered chars, and shorter
        // paths beat longer ones at equal score.
        let tokens: Vec<&str> = q.split_whitespace().collect();
        paths.retain(|p| {
            let lower = p.to_lowercase();
            tokens.iter().all(|t| lower.contains(*t))
        });
        paths.sort_by_cached_key(|p| score_path(p, &q));
    }

    let limit = limit.unwrap_or(200) as usize;
    paths.truncate(limit);
    Ok(paths)
}

/// Lower scores rank higher. Composite:
///   - prefer matches in the basename
///   - prefer contiguous substring matches
///   - tiebreak on path length
fn score_path(path: &str, query: &str) -> (u32, usize) {
    let lower = path.to_lowercase();
    let basename = lower.rsplit_once('/').map(|(_, b)| b).unwrap_or(&lower);
    let bonus: u32 = if basename.contains(query) {
        0
    } else if lower.contains(query) {
        1000
    } else {
        2000
    };
    (bonus, path.len())
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
        // Per-file cap *and* a column cutoff so a single minified
        // bundle or vendored file can't dominate the result set or
        // produce 5MB lines that hang the frontend's text rendering.
        .arg("--max-count=50")
        .arg("--max-columns=400")
        .arg("--max-columns-preview")
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
    Ok(parse_rg_json(&stdout, 200))
}

#[derive(Deserialize)]
struct RgEvent {
    #[serde(rename = "type")]
    ty: String,
    data: Option<serde_json::Value>,
}

fn parse_rg_json(stdout: &str, cap: usize) -> Vec<SearchHit> {
    let mut hits = Vec::with_capacity(cap);
    for line in stdout.lines() {
        // Global match cap. rg only enforces per-file caps; without
        // this, a broad regex against a large repo can ship tens of
        // thousands of hits through the bridge into a render loop
        // that doesn't expect them. Capping at the search layer keeps
        // the frontend snappy and the IPC payload small.
        if hits.len() >= cap {
            break;
        }
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
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- ripgrep parser ---------- */

    #[test]
    fn rg_empty_input_returns_no_hits() {
        assert!(parse_rg_json("", 200).is_empty());
    }

    #[test]
    fn rg_parses_a_single_match_line() {
        let raw = r#"{"type":"match","data":{"path":{"text":"src/main.rs"},"lines":{"text":"fn main() {\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"main"},"start":3,"end":7}]}}"#;
        let hits = parse_rg_json(raw, 200);
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
        let hits = parse_rg_json(raw, 200);
        assert!(hits.is_empty());
    }

    #[test]
    fn rg_skips_malformed_json_lines() {
        let raw = "not json at all\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"a.rs\"},\"lines\":{\"text\":\"x\"},\"line_number\":7,\"submatches\":[{\"match\":{\"text\":\"x\"},\"start\":0,\"end\":1}]}}\n\
                   {bad}\n";
        let hits = parse_rg_json(raw, 200);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.rs");
        assert_eq!(hits[0].line, 7);
    }

    #[test]
    fn rg_preserves_match_order_across_multiple_files() {
        let raw = "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"a.rs\"},\"lines\":{\"text\":\"foo\"},\"line_number\":1,\"submatches\":[{\"start\":0,\"end\":3}]}}\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"b.rs\"},\"lines\":{\"text\":\"bar foo\"},\"line_number\":12,\"submatches\":[{\"start\":4,\"end\":7}]}}\n";
        let hits = parse_rg_json(raw, 200);
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
        let hits = parse_rg_json(raw, 200);
        assert_eq!(hits[0].text, "hello");
    }

    #[test]
    fn rg_match_without_submatches_defaults_column_to_one() {
        let raw = r#"{"type":"match","data":{"path":{"text":"x"},"lines":{"text":"line"},"line_number":4,"submatches":[]}}"#;
        let hits = parse_rg_json(raw, 200);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].column, 1);
    }

    #[test]
    fn rg_respects_global_cap() {
        // Three match events, cap of 2 — parser stops after two and
        // never touches the third even if it'd be otherwise valid.
        let raw = "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"a\"},\"lines\":{\"text\":\"x\"},\"line_number\":1,\"submatches\":[{\"start\":0,\"end\":1}]}}\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"b\"},\"lines\":{\"text\":\"x\"},\"line_number\":2,\"submatches\":[{\"start\":0,\"end\":1}]}}\n\
                   {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"c\"},\"lines\":{\"text\":\"x\"},\"line_number\":3,\"submatches\":[{\"start\":0,\"end\":1}]}}\n";
        let hits = parse_rg_json(raw, 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a");
        assert_eq!(hits[1].path, "b");
    }
}
