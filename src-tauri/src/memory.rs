//! GLI memory layer.
//!
//! SQLite (bundled) + FTS5 for keyword search and recency for "what
//! happened recently here." Embedding column reserved as a BLOB so we
//! can layer vector ranking later — the Gemini embedding API is
//! already wired in `gemini.rs`. Vector ranking adds roughly:
//!   - embed each entry on insert (one Flash-Lite-tier API call)
//!   - load embeddings of FTS-candidate rows on recall
//!   - cosine-similarity rank Rust-side (a few thousand entries × 768
//!     floats fits in a millisecond on any modern CPU)
//! For v1 we keep it FTS-only — fewer moving parts, zero added
//! latency on writes, no cold-start cost. Upgrade when we feel the
//! limits.
//!
//! Storage: `~/Library/Application Support/dev.raeedz.gli/gli.db` on macOS.
//!
//! Stores three kinds of entries:
//!   - `transcript`: rolling agent PTY scrollback summaries (Task #13)
//!   - `qa`: highlight-and-ask Q&A pairs (Task #7)
//!   - `fact`: per-project facts asserted by the user or extracted
//!     by Flash-Lite from agent output

mod dedupe;
mod extract;
pub mod daemon;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use uuid::Uuid;

#[derive(Default)]
pub struct MemoryState {
    db: Mutex<Option<Connection>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Transcript,
    Qa,
    Fact,
}

impl MemoryKind {
    fn as_str(self) -> &'static str {
        match self {
            MemoryKind::Transcript => "transcript",
            MemoryKind::Qa => "qa",
            MemoryKind::Fact => "fact",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct StoreArgs {
    pub kind: MemoryKind,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub content: String,
    /** Optional Gemini embedding — enables vector ranking on recall. */
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Deserialize)]
pub struct RecallArgs {
    pub query: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    /** Max results, default 10. */
    pub limit: Option<u32>,
    /**
     * Optional embedding of the query. When provided, FTS5 candidate
     * rows are re-ranked by cosine similarity to this vector. When
     * absent, FTS5 bm25 + recency ordering is used (backward compatible).
     */
    #[serde(default)]
    pub query_embedding: Option<Vec<f32>>,
}

#[derive(Debug, Serialize)]
pub struct Memory {
    pub id: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub last_accessed_at: i64,
}

/* ------------------------------------------------------------------
   DB plumbing
   ------------------------------------------------------------------ */

fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    let new = app_data.join("gli.db");
    let old = app_data.join("rli.db");
    // One-time rename of the legacy file. WAL/SHM siblings come along
    // for the ride so SQLite picks them up cleanly under the new name.
    if old.exists() && !new.exists() {
        let _ = std::fs::rename(&old, &new);
        let _ = std::fs::rename(
            app_data.join("rli.db-wal"),
            app_data.join("gli.db-wal"),
        );
        let _ = std::fs::rename(
            app_data.join("rli.db-shm"),
            app_data.join("gli.db-shm"),
        );
    }
    Ok(new)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS memory (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            project_id TEXT,
            session_id TEXT,
            content TEXT NOT NULL,
            embedding BLOB,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project_id);
        CREATE INDEX IF NOT EXISTS memory_session_idx ON memory(session_id);
        CREATE INDEX IF NOT EXISTS memory_created_idx ON memory(created_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
            USING fts5(content, content='memory', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content)
                VALUES('delete', old.rowid, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content)
                VALUES('delete', old.rowid, old.content);
            INSERT INTO memory_fts(rowid, content)
                VALUES (new.rowid, new.content);
        END;
        "#,
    )
    .map_err(|e| e.to_string())
}

fn with_conn<R: Runtime, T>(
    app: &AppHandle<R>,
    state: &State<MemoryState>,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let p = db_path(app)?;
        let conn = Connection::open(&p).map_err(|e| e.to_string())?;
        init_schema(&conn)?;
        *guard = Some(conn);
    }
    let conn = guard.as_mut().expect("conn just initialised");
    f(conn)
}

/* ------------------------------------------------------------------
   Store + recall
   ------------------------------------------------------------------ */

#[tauri::command]
pub fn memory_store<R: Runtime>(
    app: AppHandle<R>,
    state: State<MemoryState>,
    args: StoreArgs,
) -> Result<String, String> {
    with_conn(&app, &state, move |conn| store_in_conn(conn, args))
}

#[tauri::command]
pub fn memory_recall<R: Runtime>(
    app: AppHandle<R>,
    state: State<MemoryState>,
    args: RecallArgs,
) -> Result<Vec<Memory>, String> {
    with_conn(&app, &state, |conn| recall_in_conn(conn, args))
}

/* ------------------------------------------------------------------
   Pure helpers — testable. The Tauri commands above are thin wrappers.
   ------------------------------------------------------------------ */

pub(crate) fn store_in_conn(
    conn: &Connection,
    args: StoreArgs,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    let embedding_blob: Option<Vec<u8>> = args
        .embedding
        .as_deref()
        .map(encode_embedding);
    conn.execute(
        "INSERT INTO memory(id, kind, project_id, session_id, content, embedding, created_at, last_accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            args.kind.as_str(),
            args.project_id,
            args.session_id,
            args.content,
            embedding_blob,
            ts,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Mem0-style insert: if a same-project, same-kind=fact entry is
/// already a near-match for `args.content` (Jaccard ≥ 0.6 on tokens),
/// replace its content in place rather than inserting a duplicate row.
/// Returns `(id, merged, merged_with_id)`:
///   - on insert  → (new_uuid, false, None)
///   - on merge   → (existing_uuid, true, Some(existing_uuid))
///
/// Only `Fact` kind is deduped; transcripts and Q&A pairs are
/// append-only by design.
pub(crate) fn dedupe_and_store(
    conn: &Connection,
    args: StoreArgs,
) -> Result<(String, bool, Option<String>), String> {
    if matches!(args.kind, MemoryKind::Fact) {
        if let Some(project_id) = args.project_id.as_deref() {
            if let Some((hit_id, _score)) =
                dedupe::find_similar(&args.content, project_id, conn)?
            {
                dedupe::merge_fact(&hit_id, &args.content, conn)?;
                return Ok((hit_id.clone(), true, Some(hit_id)));
            }
        }
    }
    let id = store_in_conn(conn, args)?;
    Ok((id, false, None))
}

fn encode_embedding(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn decode_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = chunk.try_into().ok()?;
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

pub(crate) fn recall_in_conn(
    conn: &Connection,
    args: RecallArgs,
) -> Result<Vec<Memory>, String> {
    let limit = args.limit.unwrap_or(10).min(100) as i64;
    let q = args.query.trim();

    // No FTS query → recency / vector fallback
    if q.is_empty() {
        return if let Some(qe) = args.query_embedding.as_deref() {
            recall_by_embedding(
                conn,
                qe,
                args.project_id.as_deref(),
                args.session_id.as_deref(),
                limit,
            )
        } else {
            recall_recent(
                conn,
                args.project_id.as_deref(),
                args.session_id.as_deref(),
                limit,
            )
        };
    }

    let phrase = format!("\"{}\"", q.replace('"', "\"\""));
    // Widen the candidate set when re-ranking with embeddings so
    // good matches that bm25 wouldn't surface still get a chance.
    let candidate_limit = if args.query_embedding.is_some() {
        (limit * 5).max(50)
    } else {
        limit
    };

    let sql = "
        SELECT m.id, m.kind, m.project_id, m.session_id, m.content, m.embedding,
               m.created_at, m.last_accessed_at, bm25(memory_fts) AS rank
        FROM memory m
        JOIN memory_fts ON memory_fts.rowid = m.rowid
        WHERE memory_fts MATCH ?1
          AND (?2 IS NULL OR m.project_id = ?2)
          AND (?3 IS NULL OR m.session_id = ?3)
        ORDER BY rank ASC, m.last_accessed_at DESC
        LIMIT ?4
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![phrase, args.project_id, args.session_id, candidate_limit],
            row_to_memory_with_embedding,
        )
        .map_err(|e| e.to_string())?;
    let mut candidates: Vec<MemoryWithEmbedding> = rows.filter_map(|r| r.ok()).collect();

    // Re-rank by cosine similarity if we have a query embedding
    if let Some(qe) = args.query_embedding.as_deref() {
        candidates.sort_by(|a, b| {
            let sa = a
                .embedding
                .as_deref()
                .map(|v| cosine_similarity(qe, v))
                .unwrap_or(f32::MIN);
            let sb = b
                .embedding
                .as_deref()
                .map(|v| cosine_similarity(qe, v))
                .unwrap_or(f32::MIN);
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    let out: Vec<Memory> = candidates
        .into_iter()
        .take(limit as usize)
        .map(|m| m.memory)
        .collect();

    // Touch last_accessed_at for returned rows.
    if !out.is_empty() {
        let ts = now_ms();
        let placeholders: Vec<&str> = out.iter().map(|_| "?").collect();
        let upd = format!(
            "UPDATE memory SET last_accessed_at = ? WHERE id IN ({})",
            placeholders.join(",")
        );
        let mut p: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(out.len() + 1);
        p.push(&ts);
        for m in &out {
            p.push(&m.id);
        }
        let _ = conn.execute(&upd, p.as_slice());
    }

    Ok(out)
}

struct MemoryWithEmbedding {
    memory: Memory,
    embedding: Option<Vec<f32>>,
}

fn row_to_memory_with_embedding(
    row: &rusqlite::Row,
) -> rusqlite::Result<MemoryWithEmbedding> {
    let blob: Option<Vec<u8>> = row.get(5)?;
    Ok(MemoryWithEmbedding {
        memory: Memory {
            id: row.get(0)?,
            kind: row.get(1)?,
            project_id: row.get(2)?,
            session_id: row.get(3)?,
            content: row.get(4)?,
            created_at: row.get(6)?,
            last_accessed_at: row.get(7)?,
        },
        embedding: blob.as_deref().and_then(decode_embedding),
    })
}

fn recall_by_embedding(
    conn: &Connection,
    query_embedding: &[f32],
    project_id: Option<&str>,
    session_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Memory>, String> {
    // Pull a wide-ish recent slice with embeddings, rank by cosine.
    let sql = "
        SELECT id, kind, project_id, session_id, content, embedding,
               created_at, last_accessed_at, 0.0 AS rank
        FROM memory
        WHERE embedding IS NOT NULL
          AND (?1 IS NULL OR project_id = ?1)
          AND (?2 IS NULL OR session_id = ?2)
        ORDER BY created_at DESC
        LIMIT 500
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![project_id, session_id],
            row_to_memory_with_embedding,
        )
        .map_err(|e| e.to_string())?;
    let mut candidates: Vec<MemoryWithEmbedding> = rows.filter_map(|r| r.ok()).collect();
    candidates.sort_by(|a, b| {
        let sa = a
            .embedding
            .as_deref()
            .map(|v| cosine_similarity(query_embedding, v))
            .unwrap_or(f32::MIN);
        let sb = b
            .embedding
            .as_deref()
            .map(|v| cosine_similarity(query_embedding, v))
            .unwrap_or(f32::MIN);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(candidates
        .into_iter()
        .take(limit as usize)
        .map(|m| m.memory)
        .collect())
}

pub(crate) fn delete_in_conn(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM memory WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn recall_recent(
    conn: &Connection,
    project_id: Option<&str>,
    session_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Memory>, String> {
    let sql = "
        SELECT id, kind, project_id, session_id, content, created_at, last_accessed_at
        FROM memory
        WHERE (?1 IS NULL OR project_id = ?1)
          AND (?2 IS NULL OR session_id = ?2)
        ORDER BY created_at DESC
        LIMIT ?3
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id, session_id, limit], row_to_memory)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        kind: row.get(1)?,
        project_id: row.get(2)?,
        session_id: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        last_accessed_at: row.get(6)?,
    })
}

#[tauri::command]
pub fn memory_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<MemoryState>,
    id: String,
) -> Result<(), String> {
    with_conn(&app, &state, move |conn| delete_in_conn(conn, &id))
}

/* ------------------------------------------------------------------
   Graph view — Obsidian-style memory visualization
   ------------------------------------------------------------------ */

/// Minimum cosine similarity for two memories to be linked in the
/// graph. 0.65 is loose enough that semantically related facts ("we
/// use bun" / "build pipeline runs bun install") connect, but tight
/// enough that random pairs ("auth tokens are 32 bytes" / "chrome
/// runs on port 4000") stay disconnected. Tuneable.
const GRAPH_EDGE_THRESHOLD: f32 = 0.65;

/// Hard cap on nodes in a single graph payload. With N nodes we run
/// N²/2 cosine comparisons + O(N²) edges to serialize. 1500 nodes ≈
/// 1.1M comparisons in <500 ms on a modern CPU; beyond that the
/// frontend force simulation also gets sluggish.
const GRAPH_NODE_CAP: usize = 1500;

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    /// `a` is always the lexicographically smaller id so the edge set
    /// has no duplicates / mirror entries.
    pub a: String,
    pub b: String,
    /// Cosine similarity, [GRAPH_EDGE_THRESHOLD, 1.0].
    pub weight: f32,
}

#[derive(Debug, Serialize)]
pub struct GraphPayload {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// Number of memories that exist for the filter but had no
    /// embedding — surfaced so the frontend can render an "N memories
    /// without embeddings" hint instead of silently dropping them.
    pub orphan_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct GraphArgs {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[tauri::command]
pub fn memory_graph_data<R: Runtime>(
    app: AppHandle<R>,
    state: State<MemoryState>,
    args: GraphArgs,
) -> Result<GraphPayload, String> {
    with_conn(&app, &state, move |conn| {
        graph_in_conn(conn, args.project_id.as_deref(), args.session_id.as_deref())
    })
}

pub(crate) fn graph_in_conn(
    conn: &Connection,
    project_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<GraphPayload, String> {
    let sql = "
        SELECT id, kind, project_id, session_id, content, embedding, created_at
        FROM memory
        WHERE (?1 IS NULL OR project_id = ?1)
          AND (?2 IS NULL OR session_id = ?2)
        ORDER BY created_at DESC
        LIMIT ?3
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![project_id, session_id, GRAPH_NODE_CAP as i64],
            |row| {
                let blob: Option<Vec<u8>> = row.get(5)?;
                Ok::<(GraphNode, Option<Vec<f32>>), rusqlite::Error>((
                    GraphNode {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        project_id: row.get(2)?,
                        session_id: row.get(3)?,
                        content: row.get(4)?,
                        created_at: row.get(6)?,
                    },
                    blob.as_deref().and_then(decode_embedding),
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut embeddings: Vec<Option<Vec<f32>>> = Vec::new();
    let mut orphan_count: usize = 0;
    for r in rows {
        match r {
            Ok((n, emb)) => {
                if emb.is_none() {
                    orphan_count += 1;
                }
                nodes.push(n);
                embeddings.push(emb);
            }
            Err(_) => continue,
        }
    }

    // Pairwise cosine — O(N²) but cheap for ≤1500 nodes (Gemini text
    // embeddings are 768 floats; 1500² × 768 ≈ 1.7B ops worst case,
    // dominated by SIMD-friendly multiplies. In practice <500 ms).
    let mut edges: Vec<GraphEdge> = Vec::new();
    for i in 0..nodes.len() {
        let Some(ei) = embeddings[i].as_deref() else { continue };
        for j in (i + 1)..nodes.len() {
            let Some(ej) = embeddings[j].as_deref() else { continue };
            let s = cosine_similarity(ei, ej);
            if s >= GRAPH_EDGE_THRESHOLD {
                let (a, b) = if nodes[i].id < nodes[j].id {
                    (nodes[i].id.clone(), nodes[j].id.clone())
                } else {
                    (nodes[j].id.clone(), nodes[i].id.clone())
                };
                edges.push(GraphEdge { a, b, weight: s });
            }
        }
    }

    Ok(GraphPayload { nodes, edges, orphan_count })
}

/* ------------------------------------------------------------------
   Tests — drive the pure helpers against an in-memory SQLite. These
   prove the schema, FTS5 wiring, and recall ranking actually work.
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let conn = Connection::open(":memory:").unwrap();
        init_schema(&conn).expect("init schema");
        conn
    }

    fn store(
        conn: &Connection,
        kind: MemoryKind,
        project: Option<&str>,
        session: Option<&str>,
        content: &str,
    ) -> String {
        store_in_conn(
            conn,
            StoreArgs {
                kind,
                project_id: project.map(|s| s.to_string()),
                session_id: session.map(|s| s.to_string()),
                content: content.to_string(),
                embedding: None,
            },
        )
        .unwrap()
    }

    fn store_with_embedding(
        conn: &Connection,
        kind: MemoryKind,
        content: &str,
        embedding: Vec<f32>,
    ) -> String {
        store_in_conn(
            conn,
            StoreArgs {
                kind,
                project_id: None,
                session_id: None,
                content: content.to_string(),
                embedding: Some(embedding),
            },
        )
        .unwrap()
    }

    fn recall(
        conn: &Connection,
        query: &str,
        project: Option<&str>,
        session: Option<&str>,
    ) -> Vec<Memory> {
        recall_in_conn(
            conn,
            RecallArgs {
                query: query.to_string(),
                project_id: project.map(|s| s.to_string()),
                session_id: session.map(|s| s.to_string()),
                limit: Some(50),
                query_embedding: None,
            },
        )
        .unwrap()
    }

    fn recall_with_embedding(
        conn: &Connection,
        query: &str,
        embedding: Vec<f32>,
    ) -> Vec<Memory> {
        recall_in_conn(
            conn,
            RecallArgs {
                query: query.to_string(),
                project_id: None,
                session_id: None,
                limit: Some(50),
                query_embedding: Some(embedding),
            },
        )
        .unwrap()
    }

    #[test]
    fn store_then_recall_returns_the_stored_content() {
        let conn = fresh_db();
        let id = store(
            &conn,
            MemoryKind::Fact,
            Some("p1"),
            None,
            "the user prefers warm-tinted dark mode terminals",
        );
        assert!(!id.is_empty());

        let hits = recall(&conn, "warm-tinted dark mode", None, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, id);
        assert!(hits[0].content.contains("warm-tinted"));
        assert_eq!(hits[0].kind, "fact");
    }

    #[test]
    fn recall_filters_by_project_id() {
        let conn = fresh_db();
        let _ = store(
            &conn,
            MemoryKind::Fact,
            Some("p_alpha"),
            None,
            "alpha auth tokens use 32 bytes",
        );
        let _ = store(
            &conn,
            MemoryKind::Fact,
            Some("p_beta"),
            None,
            "beta uses 64 byte tokens",
        );

        let alpha_only = recall(&conn, "tokens", Some("p_alpha"), None);
        assert_eq!(alpha_only.len(), 1);
        assert_eq!(alpha_only[0].project_id.as_deref(), Some("p_alpha"));

        let both = recall(&conn, "tokens", None, None);
        assert_eq!(both.len(), 2);
    }

    #[test]
    fn empty_query_returns_recent_entries_in_descending_order() {
        let conn = fresh_db();
        let first = store(&conn, MemoryKind::Fact, None, None, "first entry");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = store(&conn, MemoryKind::Fact, None, None, "second entry");

        let hits = recall(&conn, "", None, None);
        assert_eq!(hits.len(), 2);
        // Most recent first
        assert_eq!(hits[0].id, second);
        assert_eq!(hits[1].id, first);
    }

    #[test]
    fn delete_removes_entry_from_recall() {
        let conn = fresh_db();
        let id = store(&conn, MemoryKind::Qa, None, None, "purgeable Q&A");
        assert_eq!(recall(&conn, "purgeable", None, None).len(), 1);

        delete_in_conn(&conn, &id).unwrap();
        assert!(recall(&conn, "purgeable", None, None).is_empty());
    }

    #[test]
    fn recall_unknown_term_returns_empty() {
        let conn = fresh_db();
        store(&conn, MemoryKind::Fact, None, None, "nothing matches xyz");
        let hits = recall(&conn, "completely-different-term", None, None);
        assert!(hits.is_empty());
    }

    /* ---------- embedding helpers ---------- */

    #[test]
    fn cosine_identical_vectors_is_one() {
        let v = vec![0.1, 0.2, 0.3, 0.4];
        let s = cosine_similarity(&v, &v);
        assert!((s - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let s = cosine_similarity(&a, &b);
        assert!(s.abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_vectors_is_negative_one() {
        let a = vec![1.0, 2.0, 3.0];
        let b = vec![-1.0, -2.0, -3.0];
        let s = cosine_similarity(&a, &b);
        assert!((s + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_empty_or_mismatched_vectors_is_zero() {
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
        assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0]), 0.0);
    }

    #[test]
    fn embedding_roundtrips_through_blob() {
        let v: Vec<f32> = vec![0.0, 1.5, -2.25, 3.14159, f32::MIN, f32::MAX];
        let bytes = encode_embedding(&v);
        assert_eq!(bytes.len(), v.len() * 4);
        let decoded = decode_embedding(&bytes).expect("must decode");
        assert_eq!(decoded.len(), v.len());
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
    }

    #[test]
    fn decode_rejects_bytes_with_non_multiple_of_4_length() {
        assert_eq!(decode_embedding(&[0u8, 0, 0]), None);
    }

    /* ---------- end-to-end embedding rerank ---------- */

    #[test]
    fn store_then_recall_with_embedding_reranks_by_cosine() {
        let conn = fresh_db();
        // Two entries that both match the FTS query "tokens" — bm25
        // would tie them on this vocabulary, but the second has an
        // embedding much closer to the query embedding.
        let _far = store_with_embedding(
            &conn,
            MemoryKind::Fact,
            "auth uses 32-byte tokens",
            vec![1.0, 0.0, 0.0],
        );
        let near = store_with_embedding(
            &conn,
            MemoryKind::Fact,
            "session tokens stored in keychain",
            vec![0.0, 1.0, 0.0],
        );
        // Query embedding is parallel to `near`'s.
        let hits = recall_with_embedding(&conn, "tokens", vec![0.0, 1.0, 0.0]);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, near, "vector-closer entry should rank first");
    }

    #[test]
    fn embedding_recall_with_empty_query_falls_back_to_vector_only() {
        let conn = fresh_db();
        let near = store_with_embedding(
            &conn,
            MemoryKind::Fact,
            "the closest thing",
            vec![0.0, 1.0, 0.0],
        );
        let _far = store_with_embedding(
            &conn,
            MemoryKind::Fact,
            "the farther thing",
            vec![1.0, 0.0, 0.0],
        );
        let hits = recall_with_embedding(&conn, "", vec![0.0, 1.0, 0.0]);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].id, near);
    }

    #[test]
    fn embedding_persists_through_store() {
        // Sanity check that we can store with an embedding and later retrieve
        // the same row's content (we don't expose the embedding through Memory,
        // but it must still be on disk for cosine to use).
        let conn = fresh_db();
        let id = store_with_embedding(
            &conn,
            MemoryKind::Fact,
            "stored with vector",
            vec![0.5, 0.5, 0.5],
        );
        // FTS path
        let hits = recall(&conn, "stored", None, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, id);
        // Vector path
        let hits = recall_with_embedding(&conn, "stored", vec![0.5, 0.5, 0.5]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, id);
    }
}
