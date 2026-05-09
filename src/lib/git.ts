import { invoke } from "@tauri-apps/api/core";
import type { AgentCli } from "@/state/types";
import { helperRun } from "./helper-agent";

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

export interface BranchEntry {
  name: string;
  current: boolean;
}

export const git = {
  status: (cwd: string) => invoke<StatusResult>("git_status", { cwd }),
  diff: (cwd: string, path?: string, staged = false) =>
    invoke<string>("git_diff", { cwd, path, staged }),
  stage: (cwd: string, paths: string[]) =>
    invoke<void>("git_stage", { cwd, paths }),
  unstage: (cwd: string, paths: string[]) =>
    invoke<void>("git_unstage", { cwd, paths }),
  discard: (cwd: string, paths: string[]) =>
    invoke<void>("git_discard", { cwd, paths }),
  commit: (cwd: string, message: string) =>
    invoke<string>("git_commit", { cwd, message }),
  push: (cwd: string, remote?: string, branch?: string) =>
    invoke<string>("git_push", { cwd, remote, branch }),
  branchCurrent: (cwd: string) =>
    invoke<string>("git_branch_current", { cwd }),
  branchList: (cwd: string) =>
    invoke<BranchEntry[]>("git_branch_list", { cwd }),
  checkout: (cwd: string, branch: string) =>
    invoke<void>("git_checkout", { cwd, branch }),
  branchCreate: (cwd: string, name: string, from?: string) =>
    invoke<void>("git_branch_create", { cwd, name, from }),
  worktreeAdd: (cwd: string, path: string, branch: string) =>
    invoke<void>("git_worktree_add", { cwd, path, branch }),
  worktreeRemove: (cwd: string, path: string, force = false) =>
    invoke<void>("git_worktree_remove", { cwd, path, force }),
  log: (cwd: string, n?: number) =>
    invoke<LogEntry[]>("git_log", { cwd, n }),
  /**
   * Generate a commit message via the helper-agent layer. Reads the
   * staged diff, truncates, and shells out to whichever CLI the
   * caller specifies (defaults to claude). When `model` is set, the
   * helper passes `--model <model>` through to the CLI.
   */
  aiCommitMessage: async (
    cwd: string,
    cli: AgentCli = "claude",
    model?: string,
  ) => {
    const diff = await invoke<string>("git_diff", {
      cwd,
      path: undefined,
      staged: true,
    });
    if (!diff.trim()) throw new Error("no staged changes");
    const trimmed =
      diff.length > 8000
        ? diff.slice(0, 8000) + "\n\n[…truncated…]"
        : diff;
    return helperRun(cwd, cli, "commit-message", trimmed, model);
  },
};
