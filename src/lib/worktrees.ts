import { invoke } from "@tauri-apps/api/core";
import type {
  ArchiveRecord,
  Worktree,
  WorktreeId,
} from "@/state/types";

/**
 * Worktree lifecycle wrappers around the Rust commands. Backend lives
 * in `src-tauri/src/worktree.rs`.
 */

export async function worktreeList(projectPath: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("worktree_list", { projectPath });
}

export async function worktreeCreate(
  projectId: string,
  projectPath: string,
  branch: string,
  label: string,
): Promise<Worktree> {
  return invoke<Worktree>("worktree_create", {
    projectId,
    projectPath,
    branch,
    label,
  });
}

export interface ArchiveOptions {
  /** Stash dirty changes before removing the worktree (recommended). */
  stash: boolean;
  /** Pass --force to git worktree remove. */
  force: boolean;
  /** Delete the local branch after removing. */
  deleteBranch: boolean;
}

export async function worktreeArchive(
  worktree: Worktree,
  opts: ArchiveOptions,
): Promise<ArchiveRecord> {
  return invoke<ArchiveRecord>("worktree_archive", {
    worktreeId: worktree.id,
    projectId: worktree.projectId,
    branch: worktree.branch,
    name: worktree.name,
    path: worktree.path,
    createdAt: worktree.createdAt,
    lastSummary: "",
    changeCountAtArchive: worktree.changeCount,
    agentCli: worktree.agentCli,
    stash: opts.stash,
    force: opts.force,
    deleteBranch: opts.deleteBranch,
  });
}

export async function worktreeRestore(
  archiveId: string,
  projectId: string,
): Promise<Worktree> {
  return invoke<Worktree>("worktree_restore", { archiveId, projectId });
}

export async function archiveList(
  projectId: string,
): Promise<ArchiveRecord[]> {
  return invoke<ArchiveRecord[]>("archive_list", { projectId });
}

export type { WorktreeId };
