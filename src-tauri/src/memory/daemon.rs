//! Localhost HTTP daemon for the memory layer.
//!
//! Mirrors the browser daemon pattern (`src-tauri/src/browser/daemon.rs`):
//! axum on a fixed port range, port file written under
//! `~/Library/Application Support/RLI/memory-port` so cross-pane callers
//! can discover us. The `rli-memory` shell wrapper hits these routes
//! directly so any agent (claude, codex, aider) running inside any RLI
//! terminal pane can read/write the project's memory.
//!
//! Routes:
//! ```text
//! GET  /health                   → { ok, version }
//! POST /memory/add               → { id, merged, merged_with_id? }
//! POST /memory/extract           → { facts: [...] }
//! GET  /memory/search?q=..&...   → { results: [...] }
//! ```
//!
//! Bind preference: 5555..5599 (skips browser's 4000..4099 range).

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use super::{
    extract, recall_in_conn, with_conn, Memory, MemoryKind, MemoryState, RecallArgs,
    StoreArgs,
};

const PORT_FIRST: u16 = 5555;
const PORT_LAST: u16 = 5599;

/// Tauri-managed state holding the chosen daemon port. Populated once
/// the listener binds; read by `term_start` so each PTY's
/// `RLI_MEMORY_URL` env var reflects the actual port in use.
#[derive(Default)]
pub struct MemoryDaemonPort(pub Arc<AtomicU16>);

impl MemoryDaemonPort {
    pub fn get(&self) -> Option<u16> {
        let v = self.0.load(Ordering::Relaxed);
        if v == 0 { None } else { Some(v) }
    }
}

struct DaemonCtx<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> Clone for DaemonCtx<R> {
    fn clone(&self) -> Self {
        Self { app: self.app.clone() }
    }
}

/// Bind the daemon on the next free port in 5555..5599 and spawn the
/// axum server as a background tokio task. Returns the chosen port so
/// the caller can log it. The port file is also written eagerly so
/// out-of-process tools (the bash wrapper) can discover us.
pub async fn start<R: Runtime>(app: AppHandle<R>) -> Result<u16, String> {
    let ctx = DaemonCtx { app: app.clone() };
    let (listener, port) = bind_with_retry().await?;
    write_port_file(port);

    // Publish the port to the Tauri-managed state so term_start can
    // inject the right RLI_MEMORY_URL into each PTY's env. Tauri's
    // .manage() is one-shot, so we expect MemoryDaemonPort to already
    // be registered by lib.rs::run before we get here.
    if let Some(state) = app.try_state::<MemoryDaemonPort>() {
        state.0.store(port, Ordering::Relaxed);
    }

    let router = Router::new()
        .route("/health", get(health))
        .route("/memory/add", post(memory_add))
        .route("/memory/extract", post(memory_extract))
        .route("/memory/search", get(memory_search))
        .layer(CorsLayer::permissive())
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[memory daemon] axum::serve exited: {e}");
        }
    });

    Ok(port)
}

async fn bind_with_retry() -> Result<(TcpListener, u16), String> {
    for port in PORT_FIRST..=PORT_LAST {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        if let Ok(l) = TcpListener::bind(addr).await {
            return Ok((l, port));
        }
    }
    Err(format!(
        "no free port in {PORT_FIRST}..={PORT_LAST} — every port the memory daemon could use is taken"
    ))
}

fn write_port_file(port: u16) {
    let Some(dir) = dirs::data_dir() else { return };
    let dir = dir.join("RLI");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("memory-port"), port.to_string());
}

/* ------------------------------------------------------------------
   Route handlers
   ------------------------------------------------------------------ */

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

async fn health<R: Runtime>(State(_ctx): State<DaemonCtx<R>>) -> Json<Health> {
    Json(Health { ok: true, version: env!("CARGO_PKG_VERSION") })
}

#[derive(Deserialize)]
struct AddBody {
    content: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Serialize)]
struct AddResponse {
    id: String,
    merged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    merged_with_id: Option<String>,
}

async fn memory_add<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<AddBody>,
) -> Response {
    let kind = match parse_kind(body.kind.as_deref()) {
        Ok(k) => k,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let mem_state = ctx.app.state::<MemoryState>();
    let result = with_conn(&ctx.app, &mem_state, |conn| {
        super::dedupe_and_store(
            conn,
            StoreArgs {
                kind,
                project_id: body.project_id,
                session_id: body.session_id,
                content: body.content,
                embedding: None,
            },
        )
    });
    match result {
        Ok((id, merged, merged_with_id)) => Json(AddResponse {
            id,
            merged,
            merged_with_id,
        })
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct ExtractBody {
    transcript: String,
    #[serde(default)]
    project_id: Option<String>,
    /// Which CLI agent to shell out to. Defaults to "claude" when
    /// unset. Caller (rli-memory CLI / in-pane agent) typically
    /// knows which CLI it is via the `RLI_AGENT_CLI` env var.
    #[serde(default)]
    cli: Option<String>,
}

#[derive(Serialize)]
struct ExtractedFact {
    content: String,
    kind: &'static str,
}

#[derive(Serialize)]
struct ExtractResponse {
    facts: Vec<ExtractedFact>,
}

async fn memory_extract<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Json(body): Json<ExtractBody>,
) -> Response {
    let _ = body.project_id; // reserved for future scoping; not stored here
    let _ = ctx; // app handle reserved for future per-project routing
    let cli = body.cli.unwrap_or_else(|| "claude".to_string());
    match extract::extract_facts(&body.transcript, &cli).await {
        Ok(facts) => Json(ExtractResponse {
            facts: facts
                .into_iter()
                .map(|content| ExtractedFact { content, kind: "fact" })
                .collect(),
        })
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Serialize)]
struct SearchResponse {
    results: Vec<Memory>,
}

async fn memory_search<R: Runtime>(
    State(ctx): State<DaemonCtx<R>>,
    Query(q): Query<SearchQuery>,
) -> Response {
    let mem_state = ctx.app.state::<MemoryState>();
    let result = with_conn(&ctx.app, &mem_state, |conn| {
        recall_in_conn(
            conn,
            RecallArgs {
                query: q.q.unwrap_or_default(),
                project_id: q.project_id,
                session_id: q.session_id,
                limit: q.limit,
                query_embedding: None,
            },
        )
    });
    match result {
        Ok(results) => Json(SearchResponse { results }).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn parse_kind(s: Option<&str>) -> Result<MemoryKind, String> {
    match s.unwrap_or("fact") {
        "fact" => Ok(MemoryKind::Fact),
        "qa" => Ok(MemoryKind::Qa),
        "transcript" => Ok(MemoryKind::Transcript),
        other => Err(format!("invalid kind '{other}' (want fact|qa|transcript)")),
    }
}

