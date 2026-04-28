import { invoke } from "@tauri-apps/api/core";
import { gemini } from "./gemini";

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
   * Embed `content` via Gemini and store it. Falls back to plain
   * (FTS-only) store if the API key isn't set or the embed call fails —
   * memory always succeeds even when AI is offline.
   */
  embedAndStore: async (args: StoreArgs): Promise<string> => {
    let embedding: number[] | undefined;
    try {
      embedding = await gemini.embed(args.content);
    } catch {
      embedding = undefined;
    }
    return memory.store({ ...args, embedding });
  },

  /**
   * Embed the query, then recall with cosine reranking. Falls back to
   * plain FTS recall if embedding fails.
   */
  embedAndRecall: async (args: RecallArgs): Promise<Memory[]> => {
    let queryEmbedding: number[] | undefined;
    if (args.query.trim().length > 0) {
      try {
        queryEmbedding = await gemini.embed(args.query);
      } catch {
        queryEmbedding = undefined;
      }
    }
    return memory.recall({ ...args, queryEmbedding });
  },
};
