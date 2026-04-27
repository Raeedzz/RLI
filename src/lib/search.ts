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
  astGrep: (cwd: string, pattern: string, lang?: string) =>
    invoke<SearchHit[]>("search_ast_grep", { cwd, pattern, lang }),
};
