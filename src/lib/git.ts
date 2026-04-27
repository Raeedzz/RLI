import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend wrapper around the Rust-side git commands.
 * See src-tauri/src/git.rs.
 */

export interface StatusEntry {
  path: string;
  kind: string;
  staged: boolean;
}

export interface StatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

export interface LogEntry {
  hash: string;
  author: string;
  relative_time: string;
  subject: string;
}

export const git = {
  status: (cwd: string) => invoke<StatusResult>("git_status", { cwd }),
  diff: (cwd: string, path?: string, staged = false) =>
    invoke<string>("git_diff", { cwd, path, staged }),
  stage: (cwd: string, paths: string[]) =>
    invoke<void>("git_stage", { cwd, paths }),
  unstage: (cwd: string, paths: string[]) =>
    invoke<void>("git_unstage", { cwd, paths }),
  commit: (cwd: string, message: string) =>
    invoke<string>("git_commit", { cwd, message }),
  push: (cwd: string, remote?: string, branch?: string) =>
    invoke<string>("git_push", { cwd, remote, branch }),
  branchCurrent: (cwd: string) =>
    invoke<string>("git_branch_current", { cwd }),
  worktreeAdd: (cwd: string, path: string, branch: string) =>
    invoke<void>("git_worktree_add", { cwd, path, branch }),
  worktreeRemove: (cwd: string, path: string, force = false) =>
    invoke<void>("git_worktree_remove", { cwd, path, force }),
  log: (cwd: string, n?: number) =>
    invoke<LogEntry[]>("git_log", { cwd, n }),
  aiCommitMessage: (cwd: string) =>
    invoke<string>("git_ai_commit_message", { cwd }),
};
