//! Read-only adapter over the claude-mem corpus.
//!
//! claude-mem (MCP plugin) writes its vector store to
//! `~/.claude-mem/chroma/`:
//!   - `chroma.sqlite3`              — metadata: per-embedding key/value
//!     bag (`doc_type`, `project`, `chroma:document`, `created_at_epoch`,
//!     `memory_session_id`, `title`, `subtitle`).
//!   - `chroma/<segment_id>/data_level0.bin` — HNSW level-0 layer with
//!     fixed-size records: `[M0 links | linklist size | vector | label]`.
//!     `header.bin` carries the offsets.
//!
//! Internal HNSW labels are int64 and equal to `embeddings.id` in the
//! SQLite — that's how we join binary → metadata without parsing the
//! `index_metadata.pickle` file.
//!
//! Output payload mirrors the legacy `memory::GraphPayload` so the
//! existing React `GraphView` can render claude-mem nodes & cosine
//! edges with no shape changes.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, types::Value as SqlValue, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Deserialize)]
pub struct ClaudeMemGraphArgs {
    /// Filter by claude-mem `project` (e.g. `RLI`, `sckry_0.1`). When
    /// absent or empty, all projects are included.
    #[serde(default)]
    pub project: Option<String>,
    /// Soft cap on returned nodes. Defaults to 800 — 384-dim cosine
    /// across 800^2/2 pairs is ~120ms in Rust; beyond that the
    /// frontend force-sim also gets sluggish.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Edge cutoff. Default 0.55 — MiniLM-L6 (384-dim) sits on a
    /// noisier similarity floor than 768-dim Gemini embeds, so 0.65
    /// drops too many real connections.
    #[serde(default)]
    pub threshold: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct ClaudeMemGraphNode {
    /// Stable string id from Chroma (e.g. `obs_136_fact_3`,
    /// `summary_57_completed`, `prompt_42`).
    pub id: String,
    /// `doc_type` from claude-mem: `observation` | `session_summary`
    /// | `user_prompt`. Surfaced as-is so the frontend can color.
    pub kind: String,
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ClaudeMemGraphEdge {
    pub a: String,
    pub b: String,
    pub weight: f32,
}

#[derive(Debug, Serialize)]
pub struct ClaudeMemGraphPayload {
    pub nodes: Vec<ClaudeMemGraphNode>,
    pub edges: Vec<ClaudeMemGraphEdge>,
    /// Nodes whose vector wasn't found in the binary (rare — usually
    /// a metadata row whose embedding was queued but not yet flushed).
    pub orphan_count: usize,
    /// All distinct `project` values in the corpus, sorted. Lets the
    /// frontend offer a picker without a second round-trip.
    pub available_projects: Vec<String>,
    /// Pre-cap row count for the active filter. The UI uses this for
    /// "showing 800 of N" style hints.
    pub total: usize,
}

const DEFAULT_LIMIT: usize = 800;
const DEFAULT_THRESHOLD: f32 = 0.55;

fn chroma_paths() -> Result<(PathBuf, PathBuf), String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let root = home.join(".claude-mem").join("chroma");
    let db = root.join("chroma.sqlite3");
    if !db.exists() {
        return Err(format!(
            "claude-mem chroma db not found at {} — install the claude-mem MCP plugin or run a session that populates it",
            db.display()
        ));
    }
    Ok((root, db))
}

#[tauri::command]
pub fn claude_mem_graph(
    args: ClaudeMemGraphArgs,
) -> Result<ClaudeMemGraphPayload, String> {
    let (chroma_root, chroma_db) = chroma_paths()?;
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).max(1);
    let threshold = args.threshold.unwrap_or(DEFAULT_THRESHOLD);

    // SHARED so we don't block the in-process claude-mem worker that's
    // actively writing to the DB.
    let conn = Connection::open_with_flags(
        &chroma_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open chroma sqlite: {e}"))?;

    let available_projects = list_projects(&conn)?;
    let total = count_for_filter(&conn, args.project.as_deref())?;

    let kept_ids = pick_recent(&conn, args.project.as_deref(), limit)?;
    if kept_ids.is_empty() {
        return Ok(ClaudeMemGraphPayload {
            nodes: vec![],
            edges: vec![],
            orphan_count: 0,
            available_projects,
            total,
        });
    }

    let meta_bags = load_metadata(&conn, &kept_ids)?;
    let id_to_eid = load_embedding_rows(&conn, &kept_ids)?;
    let vector_segments = list_vector_segments(&conn)?;
    let label_vec = load_vectors(&chroma_root, &vector_segments, &kept_ids)?;

    // Drop entries whose vectors haven't been flushed to HNSW yet
    // (they live in `embeddings_queue` until claude-mem's worker
    // commits them). We surface the count in `orphan_count` so the
    // UI can hint at it, but keeping them as floating dots clutters
    // the canvas without conveying structure.
    let mut nodes: Vec<ClaudeMemGraphNode> = Vec::with_capacity(kept_ids.len());
    let mut node_vectors: Vec<&Vec<f32>> = Vec::with_capacity(kept_ids.len());
    let mut orphan_count = 0;
    for id in &kept_ids {
        let Some(eid) = id_to_eid.get(id) else { continue };
        let Some(vec) = label_vec.get(id) else {
            orphan_count += 1;
            continue;
        };
        let bag = meta_bags.get(id).cloned().unwrap_or_default();
        let kind = bag
            .get("doc_type")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let project = bag.get("project").cloned();
        let session_id = bag.get("memory_session_id").cloned();
        let title = bag.get("title").cloned();
        let content = bag.get("chroma:document").cloned().unwrap_or_default();
        let created_at = bag
            .get("created_at_epoch")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);

        nodes.push(ClaudeMemGraphNode {
            id: eid.clone(),
            kind,
            project,
            session_id,
            content,
            created_at,
            title,
        });
        node_vectors.push(vec);
    }

    // Pairwise cosine. O(N²) — for N=800 that's ~125ms in scalar Rust.
    let mut edges: Vec<ClaudeMemGraphEdge> = Vec::new();
    for i in 0..nodes.len() {
        for j in (i + 1)..nodes.len() {
            let s = cosine(node_vectors[i], node_vectors[j]);
            if s >= threshold {
                let (a, b) = if nodes[i].id < nodes[j].id {
                    (nodes[i].id.clone(), nodes[j].id.clone())
                } else {
                    (nodes[j].id.clone(), nodes[i].id.clone())
                };
                edges.push(ClaudeMemGraphEdge { a, b, weight: s });
            }
        }
    }

    Ok(ClaudeMemGraphPayload {
        nodes,
        edges,
        orphan_count,
        available_projects,
        total,
    })
}

/* -------------------------- helpers -------------------------- */

fn list_projects(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT string_value FROM embedding_metadata
             WHERE key='project' AND string_value IS NOT NULL
             ORDER BY string_value",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn count_for_filter(conn: &Connection, project: Option<&str>) -> Result<usize, String> {
    let n: i64 = match project {
        Some(p) if !p.is_empty() => conn
            .query_row(
                "SELECT COUNT(DISTINCT id) FROM embedding_metadata
                 WHERE key='project' AND string_value=?1",
                params![p],
                |r| r.get(0),
            )
            .unwrap_or(0),
        _ => conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
            .unwrap_or(0),
    };
    Ok(n as usize)
}

/// Pull the most-recent N embedding rows (by `created_at_epoch` desc,
/// falling back to insertion order). Project-filtered when requested.
fn pick_recent(
    conn: &Connection,
    project: Option<&str>,
    limit: usize,
) -> Result<Vec<i64>, String> {
    let sql = match project {
        Some(p) if !p.is_empty() => format!(
            "SELECT e.id FROM embeddings e
             LEFT JOIN embedding_metadata mt ON mt.id=e.id AND mt.key='created_at_epoch'
             JOIN embedding_metadata mp ON mp.id=e.id AND mp.key='project' AND mp.string_value='{}'
             ORDER BY COALESCE(mt.int_value, 0) DESC, e.id DESC
             LIMIT ?1",
            p.replace('\'', "''")
        ),
        _ => "SELECT e.id FROM embeddings e
             LEFT JOIN embedding_metadata mt ON mt.id=e.id AND mt.key='created_at_epoch'
             ORDER BY COALESCE(mt.int_value, 0) DESC, e.id DESC
             LIMIT ?1"
            .to_string(),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn load_metadata(
    conn: &Connection,
    ids: &[i64],
) -> Result<HashMap<i64, HashMap<String, String>>, String> {
    let mut bags: HashMap<i64, HashMap<String, String>> =
        ids.iter().map(|i| (*i, HashMap::new())).collect();
    let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT id, key, string_value, int_value FROM embedding_metadata
         WHERE id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_vec: Vec<SqlValue> = ids.iter().map(|i| SqlValue::Integer(*i)).collect();
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        params_vec.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            let id: i64 = row.get(0)?;
            let key: String = row.get(1)?;
            let sv: Option<String> = row.get(2)?;
            let iv: Option<i64> = row.get(3)?;
            Ok((id, key, sv, iv))
        })
        .map_err(|e| e.to_string())?;
    for r in rows.flatten() {
        let (id, key, sv, iv) = r;
        let bag = bags.entry(id).or_default();
        if let Some(s) = sv {
            bag.insert(key, s);
        } else if let Some(i) = iv {
            bag.insert(key, i.to_string());
        }
    }
    Ok(bags)
}

fn load_embedding_rows(
    conn: &Connection,
    ids: &[i64],
) -> Result<HashMap<i64, String>, String> {
    let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT id, embedding_id FROM embeddings WHERE id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_vec: Vec<SqlValue> = ids.iter().map(|i| SqlValue::Integer(*i)).collect();
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        params_vec.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok::<(i64, String), rusqlite::Error>((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut id_to_eid: HashMap<i64, String> = HashMap::new();
    for r in rows.flatten() {
        id_to_eid.insert(r.0, r.1);
    }
    Ok(id_to_eid)
}

/// HNSW vectors live in `<chroma_root>/<segment_id>/data_level0.bin`
/// where `segment_id` is the VECTOR-scope segment from the `segments`
/// table. The `embeddings.segment_id` column points at the METADATA
/// segment (which is the SQLite itself) and isn't useful here.
fn list_vector_segments(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM segments WHERE scope='VECTOR'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Walk each VECTOR segment's `data_level0.bin` once. Each fixed-size
/// record has the layout described in `header.bin`. We read only the
/// bytes for labels we care about and skip everything else.
fn load_vectors(
    chroma_root: &Path,
    vector_segments: &[String],
    ids: &[i64],
) -> Result<HashMap<i64, Vec<f32>>, String> {
    let wanted: HashSet<i64> = ids.iter().copied().collect();
    let mut out: HashMap<i64, Vec<f32>> = HashMap::with_capacity(ids.len());
    for seg in vector_segments {
        let dir = chroma_root.join(seg);
        let bin = dir.join("data_level0.bin");
        let header = dir.join("header.bin");
        if !bin.exists() {
            continue;
        }
        let layout = read_hnsw_header(&header).unwrap_or(HnswLayout {
            size_per_elem: 1676,
            offset_data: 132,
            label_offset: 1668,
            dim: 384,
        });
        let bytes = match fs::read(&bin) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[claude-mem] read {}: {e}", bin.display());
                continue;
            }
        };
        if layout.size_per_elem == 0 {
            continue;
        }
        let count = bytes.len() / layout.size_per_elem;
        for i in 0..count {
            let off = i * layout.size_per_elem;
            let label_at = off + layout.label_offset;
            if label_at + 8 > bytes.len() {
                break;
            }
            let label = i64::from_le_bytes(
                bytes[label_at..label_at + 8].try_into().unwrap(),
            );
            if !wanted.contains(&label) {
                continue;
            }
            let vec_at = off + layout.offset_data;
            let vec_end = vec_at + layout.dim * 4;
            if vec_end > bytes.len() {
                break;
            }
            let mut v = Vec::with_capacity(layout.dim);
            for chunk in bytes[vec_at..vec_end].chunks_exact(4) {
                v.push(f32::from_le_bytes(chunk.try_into().unwrap()));
            }
            out.insert(label, v);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy)]
struct HnswLayout {
    size_per_elem: usize,
    offset_data: usize,
    label_offset: usize,
    dim: usize,
}

fn read_hnsw_header(path: &Path) -> Result<HnswLayout, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 0x30 {
        return Err("header too short".into());
    }
    let read_u64 = |off: usize| -> usize {
        u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()) as usize
    };
    // hnswlib layout: offsetLevel0(0), max_elements(8), cur_count(16),
    // size_data_per_element(24), label_offset(32), offset_data(40), …
    let size_per_elem = read_u64(0x18);
    let label_offset = read_u64(0x20);
    let offset_data = read_u64(0x28);
    if label_offset <= offset_data || size_per_elem < label_offset + 8 {
        return Err("malformed header".into());
    }
    let dim = (label_offset - offset_data) / 4;
    Ok(HnswLayout {
        size_per_elem,
        offset_data,
        label_offset,
        dim,
    })
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let d = na.sqrt() * nb.sqrt();
    if d == 0.0 {
        0.0
    } else {
        dot / d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_self_is_one() {
        let v = vec![0.1, 0.2, 0.3, 0.4];
        assert!((cosine(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn header_parses_default_layout() {
        // Synthesize a header matching what we observed in real Chroma.
        // Fields up to offset 0x30 are enough.
        let mut bytes = vec![0u8; 0x60];
        // 0x18: size_per_elem = 1676
        bytes[0x18..0x20].copy_from_slice(&1676u64.to_le_bytes());
        // 0x20: label_offset = 1668
        bytes[0x20..0x28].copy_from_slice(&1668u64.to_le_bytes());
        // 0x28: offset_data = 132
        bytes[0x28..0x30].copy_from_slice(&132u64.to_le_bytes());
        let dir = std::env::temp_dir().join(format!(
            "claude_mem_header_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("header.bin");
        std::fs::write(&p, &bytes).unwrap();
        let h = read_hnsw_header(&p).unwrap();
        assert_eq!(h.size_per_elem, 1676);
        assert_eq!(h.label_offset, 1668);
        assert_eq!(h.offset_data, 132);
        assert_eq!(h.dim, 384);
    }
}
