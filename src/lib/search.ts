import { invoke } from "@tauri-apps/api/core";

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export const search = {
  rg: (cwd: string, query: string, regex: boolean) =>
    invoke<SearchHit[]>("search_rg", { cwd, query, regex }),
  /**
   * List project files for the file-picker mode of the search
   * overlay. Empty `query` returns the full file set (capped at
   * `limit`, default 200); non-empty queries fuzzy-filter and rank
   * server-side so the UI stays a thin renderer.
   */
  files: (cwd: string, query: string, limit?: number) =>
    invoke<string[]>("search_files", { cwd, query, limit }),
};
