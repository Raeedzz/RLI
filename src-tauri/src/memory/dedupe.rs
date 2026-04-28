//! Mem0-style dedupe-on-add for the memory layer.
//!
//! Before inserting a new fact, sweep the project's existing facts for
//! a near-match. If found, replace the old content in-place rather
//! than insert a duplicate row. Keeps the memory table tight and the
//! retrieval signal sharp — without burning a Gemini API call per add.
//!
//! v1 strategy: FTS5 picks the top 5 keyword-overlap candidates,
//! Jaccard token similarity reranks them. Threshold 0.6 — tuned so
//! "we use bun" vs "use bun, not npm" merges, but two genuinely
//! distinct facts about bun stay separate.

use std::collections::HashSet;

use rusqlite::{params, Connection};

const SIMILARITY_THRESHOLD: f32 = 0.6;
const FTS_CANDIDATE_LIMIT: usize = 5;

/// Tokenize a string for Jaccard comparison: lowercase, split on
/// non-alphanumeric, drop empties + tokens shorter than 2 chars (common
/// stopwords like "a", "is", "of" otherwise dominate the intersection).
fn tokens(s: &str) -> HashSet<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_lowercase())
        .collect()
}

/// |A ∩ B| / |A ∪ B|. Returns 0.0 for two empty sets so dedupe never
/// fires on a content-free comparison.
fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f32;
    let union = a.union(b).count() as f32;
    if union == 0.0 { 0.0 } else { inter / union }
}

/// Build an FTS5 MATCH expression that ORs the needle's tokens.
/// Without this, FTS5 defaults to AND across tokens — so the needle
/// "we use bun" wouldn't match an existing row "use bun" because "we"
/// is missing. We want any-token-overlap to surface candidates.
fn fts_or_query(needle: &str) -> String {
    let toks: Vec<String> = needle
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_lowercase())
        .collect();
    if toks.is_empty() {
        return String::new();
    }
    toks.join(" OR ")
}

/// Search for an existing fact in `project_id` that is semantically
/// close to `needle`. Returns `Some((id, score))` if the best Jaccard
/// score exceeds `SIMILARITY_THRESHOLD`, else `None`.
///
/// Only considers `kind = 'fact'` rows — transcripts and Q&A pairs
/// are append-only by design and shouldn't dedupe-merge.
pub fn find_similar(
    needle: &str,
    project_id: &str,
    conn: &Connection,
) -> Result<Option<(String, f32)>, String> {
    let q = fts_or_query(needle);
    if q.is_empty() {
        return Ok(None);
    }

    let sql = "
        SELECT m.id, m.content
        FROM memory m
        JOIN memory_fts ON memory_fts.rowid = m.rowid
        WHERE memory_fts MATCH ?1
          AND m.project_id = ?2
          AND m.kind = 'fact'
        ORDER BY bm25(memory_fts) ASC
        LIMIT ?3
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![q, project_id, FTS_CANDIDATE_LIMIT as i64],
            |row| Ok::<(String, String), rusqlite::Error>((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let needle_tokens = tokens(needle);
    let mut best: Option<(String, f32)> = None;
    for r in rows {
        let (id, content) = match r {
            Ok(v) => v,
            Err(_) => continue,
        };
        let score = jaccard(&needle_tokens, &tokens(&content));
        if score >= SIMILARITY_THRESHOLD {
            if best.as_ref().map(|(_, s)| score > *s).unwrap_or(true) {
                best = Some((id, score));
            }
        }
    }
    Ok(best)
}

/// Replace `old_id`'s content with `new_content` and bump
/// `last_accessed_at`. Atomic-fact replacement — no concatenation, no
/// versioning. The merge_with_id is returned to the caller so the API
/// response can tell the user which prior fact got replaced.
pub fn merge_fact(
    old_id: &str,
    new_content: &str,
    conn: &Connection,
) -> Result<(), String> {
    let ts = super::now_ms();
    conn.execute(
        "UPDATE memory SET content = ?1, last_accessed_at = ?2 WHERE id = ?3",
        params![new_content, ts, old_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{init_schema, store_in_conn, MemoryKind, StoreArgs};
    use super::*;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let c = Connection::open(":memory:").unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn store_fact(conn: &Connection, project: &str, content: &str) -> String {
        store_in_conn(
            conn,
            StoreArgs {
                kind: MemoryKind::Fact,
                project_id: Some(project.to_string()),
                session_id: None,
                content: content.to_string(),
                embedding: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn jaccard_basic() {
        let a = tokens("we use bun, not npm");
        let b = tokens("use bun instead of npm");
        // {we, use, bun, not, npm} ∩ {use, bun, instead, of, npm} = {use, bun, npm}
        // ∪ = {we, use, bun, not, npm, instead, of} → 3/7 ≈ 0.43
        assert!(jaccard(&a, &b) > 0.4);
    }

    #[test]
    fn finds_near_duplicate_in_same_project() {
        let conn = fresh();
        let id1 = store_fact(&conn, "p1", "we use bun, not npm, for builds");
        let hit = find_similar("we use bun for builds", "p1", &conn).unwrap();
        assert!(hit.is_some(), "expected to find a near-match");
        assert_eq!(hit.unwrap().0, id1);
    }

    #[test]
    fn ignores_other_projects() {
        let conn = fresh();
        let _ = store_fact(&conn, "p1", "we use bun for builds");
        let hit = find_similar("we use bun for builds", "p2", &conn).unwrap();
        assert!(hit.is_none(), "must not match across projects");
    }

    #[test]
    fn ignores_low_overlap() {
        let conn = fresh();
        let _ = store_fact(&conn, "p1", "auth tokens are 32 bytes");
        let hit = find_similar("logs are written to journald", "p1", &conn).unwrap();
        assert!(hit.is_none(), "unrelated facts must not merge");
    }

    #[test]
    fn merge_replaces_content_and_keeps_id() {
        let conn = fresh();
        let id = store_fact(&conn, "p1", "old text");
        merge_fact(&id, "new text", &conn).unwrap();
        let row: String = conn
            .query_row(
                "SELECT content FROM memory WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(row, "new text");
    }
}
