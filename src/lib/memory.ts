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
