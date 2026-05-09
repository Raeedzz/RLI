import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend wrapper around the Rust-side memory commands.
 * See src-tauri/src/memory.rs for storage details.
 */

export type MemoryKind = "transcript" | "qa" | "fact";

export interface Memory {
  id: string;
  kind: MemoryKind;
  project_id: string | null;
  session_id: string | null;
  content: string;
  created_at: number;
  last_accessed_at: number;
}

export interface StoreArgs {
  kind: MemoryKind;
  projectId?: string;
  sessionId?: string;
  content: string;
  /** Optional precomputed embedding (e.g. from a Flash-Lite call). */
  embedding?: number[];
}

export interface RecallArgs {
  query: string;
  projectId?: string;
  sessionId?: string;
  limit?: number;
  /** Optional precomputed query embedding for cosine reranking. */
  queryEmbedding?: number[];
}

export interface GraphNode {
  id: string;
  kind: MemoryKind;
  project_id: string | null;
  session_id: string | null;
  content: string;
  created_at: number;
}

export interface GraphEdge {
  /** Lexicographically-smaller node id of the pair. */
  a: string;
  b: string;
  /** Cosine similarity ∈ [0.65, 1.0]. */
  weight: number;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of memories returned without an embedding (no edges). */
  orphan_count: number;
}

/**
 * Doc kinds emitted by claude-mem (via its `embedding_metadata.doc_type`
 * key). Surfaced verbatim from the Rust adapter so future kinds appear
 * in the graph without a frontend change — `GraphView` falls back to a
 * neutral color when it sees an unknown value.
 */
export type ClaudeMemKind =
  | "observation"
  | "session_summary"
  | "user_prompt"
  | (string & {});

export interface ClaudeMemNode {
  id: string;
  kind: ClaudeMemKind;
  project: string | null;
  session_id: string | null;
  content: string;
  created_at: number;
  title: string | null;
}

export interface ClaudeMemPayload {
  nodes: ClaudeMemNode[];
  edges: GraphEdge[];
  orphan_count: number;
  available_projects: string[];
  total: number;
}

export const memory = {
  store: ({ kind, projectId, sessionId, content, embedding }: StoreArgs) =>
    invoke<string>("memory_store", {
      args: {
        kind,
        project_id: projectId,
        session_id: sessionId,
        content,
        embedding,
      },
    }),
  recall: ({
    query,
    projectId,
    sessionId,
    limit,
    queryEmbedding,
  }: RecallArgs) =>
    invoke<Memory[]>("memory_recall", {
      args: {
        query,
        project_id: projectId,
        session_id: sessionId,
        limit,
        query_embedding: queryEmbedding,
      },
    }),
  delete: (id: string) => invoke<void>("memory_delete", { id }),

  /**
   * Pull the graph view (nodes + cosine-similarity edges) for an
   * Obsidian-style visualization. Edges only exist between memories
   * that have embeddings AND a similarity ≥ 0.65. Node count is
   * capped at 1500 — see GRAPH_NODE_CAP in memory.rs.
   */
  graph: ({
    projectId,
    sessionId,
  }: { projectId?: string; sessionId?: string } = {}) =>
    invoke<GraphPayload>("memory_graph_data", {
      args: { project_id: projectId, session_id: sessionId },
    }),

  /**
   * Read the claude-mem (MCP plugin) corpus directly: pulls embedding
   * metadata + 384-dim vectors out of `~/.claude-mem/chroma/` and
   * returns nodes + cosine-similarity edges. This is what powers the
   * Memory tab — the legacy `graph()` over RLI's own `rli.db` is kept
   * as a fallback for debugging.
   *
   * @param project   filter by claude-mem `project` name (basename of repo)
   * @param limit     soft cap on returned nodes (default 800)
   * @param threshold edge cutoff cosine (default 0.55 — MiniLM is noisier than 768-dim)
   */
  claudeMemGraph: ({
    project,
    limit,
    threshold,
  }: {
    project?: string | null;
    limit?: number;
    threshold?: number;
  } = {}) =>
    invoke<ClaudeMemPayload>("claude_mem_graph", {
      args: { project: project ?? null, limit, threshold },
    }),

  /**
   * Plain FTS-backed store. Embeddings were dropped with the Gemini
   * removal — the memory layer ranks via FTS5 bm25 alone now.
   */
  embedAndStore: async (args: StoreArgs): Promise<string> => memory.store(args),

  /**
   * Plain FTS-backed recall. Same rationale as `embedAndStore`.
   */
  embedAndRecall: async (args: RecallArgs): Promise<Memory[]> =>
    memory.recall(args),
};
