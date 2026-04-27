import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fs = {
  readDir: (path: string) => invoke<DirEntry[]>("fs_read_dir", { path }),
  readTextFile: (path: string) =>
    invoke<string>("fs_read_text_file", { path }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("fs_write_text_file", { path, content }),
  cwd: () => invoke<string>("fs_cwd"),
};

/* ------------------------------------------------------------------
   System actions — right-click "Open in Finder/VS Code/browser"
   ------------------------------------------------------------------ */

export const system = {
  /** Open the path in macOS's default handler. `reveal` selects in Finder. */
  open: (path: string, reveal = false) =>
    invoke<void>("system_open", { path, reveal }),
  /** Open the path with a specific app (e.g. "Visual Studio Code"). */
  openWith: (path: string, app: string) =>
    invoke<void>("system_open_with", { path, app }),
};
