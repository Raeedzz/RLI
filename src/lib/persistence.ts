import { invoke } from "@tauri-apps/api/core";
import type {
  AppState,
  Project,
  ProjectId,
  Session,
  SessionId,
} from "../state/types";

/**
 * Frontend wrapper around the Rust state persistence commands.
 *
 * Bumps `version` on any incompatible change to PersistedState so old
 * blobs can be discarded gracefully on load. We don't write migrations;
 * the user's projects/sessions list is cheap to rebuild and the schema
 * shouldn't churn often.
 */

export const PERSISTENCE_VERSION = 1;

export interface PersistedState {
  version: number;
  projects: Project[];
  sessions: Session[];
  activeProjectId: ProjectId | null;
  activeSessionByProject: Record<ProjectId, SessionId | null>;
}

/**
 * Strip transient UI flags (palette/dialog visibility, streaming status)
 * so a restart doesn't surface a half-open menu or a stale "running" dot
 * on a long-dead PTY.
 */
export function pickPersistent(state: AppState): PersistedState {
  return {
    version: PERSISTENCE_VERSION,
    projects: state.projects,
    sessions: state.sessions.map((s) => ({
      ...s,
      // PTYs unmount on app close — every session boots back to idle.
      status: "idle" as const,
      // Same reason: any agent that was foregrounded in the session
      // is no longer running after a relaunch. Reset the flag so the
      // status bar pill doesn't ghost on for an agent that's gone.
      agentRunning: false,
      // Files over 256 KiB skip persistence; the Editor re-reads from
      // disk via onOpenFile when the user clicks back into the file.
      // Keeps the JSON blob small and avoids snapshotting binary-ish
      // blobs the editor may have failed to render anyway.
      openFile:
        s.openFile && s.openFile.content.length > 256_000
          ? { path: s.openFile.path, content: "" }
          : s.openFile,
    })),
    activeProjectId: state.activeProjectId,
    activeSessionByProject: state.activeSessionByProject,
  };
}

export async function saveState(state: AppState): Promise<void> {
  const persisted = pickPersistent(state);
  const json = JSON.stringify(persisted);
  await invoke("state_save", { content: json });
}

export async function loadState(): Promise<PersistedState | null> {
  const raw = await invoke<string | null>("state_load");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== PERSISTENCE_VERSION) {
      // Older schemas are dropped on the floor — INITIAL_STATE wins.
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearState(): Promise<void> {
  await invoke("state_clear");
}
