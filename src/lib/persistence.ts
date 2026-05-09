import { invoke } from "@tauri-apps/api/core";
import type { AppState } from "../state/types";
import { DEFAULT_SETTINGS } from "../state/types";

/**
 * Persistence wrapper around the Rust state commands.
 *
 * v2 ships the Project → Worktree → Tabs schema. v1 blobs (the previous
 * Session-based shape) are discarded on load — the user's projects and
 * worktrees are cheap to rebuild and we don't carry migrations.
 */

export const PERSISTENCE_VERSION = 2;

export interface PersistedState {
  version: number;
  /** Subset of AppState that survives a relaunch. Transient flags (palette,
      dialogs, agent-running, chat input) are stripped. */
  projects: AppState["projects"];
  projectOrder: AppState["projectOrder"];
  worktrees: AppState["worktrees"];
  tabs: AppState["tabs"];
  activeProjectId: AppState["activeProjectId"];
  activeWorktreeByProject: AppState["activeWorktreeByProject"];
  archivedWorktrees: AppState["archivedWorktrees"];
  sidebarCollapsed: AppState["sidebarCollapsed"];
  rightPanelCollapsed: AppState["rightPanelCollapsed"];
  settings: AppState["settings"];
  markdownView: AppState["markdownView"];
}

export function pickPersistent(state: AppState): PersistedState {
  // Strip transient runtime state — agent-running, chat input, markdown
  // tab content (re-read from disk on open). Tabs themselves persist so
  // a relaunch lands the user back in the same configuration.
  const tabs = { ...state.tabs };
  for (const id of Object.keys(tabs)) {
    const t = tabs[id];
    if (t.kind === "terminal") {
      tabs[id] = { ...t, agentStatus: "idle", detectedCli: null };
    } else if (t.kind === "markdown") {
      tabs[id] = { ...t, content: null };
    }
  }
  const worktrees = { ...state.worktrees };
  for (const id of Object.keys(worktrees)) {
    const w = worktrees[id];
    worktrees[id] = {
      ...w,
      agentStatus: "idle",
      agentCli: null,
      changeCount: 0,
    };
  }
  return {
    version: PERSISTENCE_VERSION,
    projects: state.projects,
    projectOrder: state.projectOrder,
    worktrees,
    tabs,
    activeProjectId: state.activeProjectId,
    activeWorktreeByProject: state.activeWorktreeByProject,
    archivedWorktrees: state.archivedWorktrees,
    sidebarCollapsed: state.sidebarCollapsed,
    rightPanelCollapsed: state.rightPanelCollapsed,
    settings: state.settings,
    markdownView: state.markdownView,
  };
}

export async function saveState(state: AppState): Promise<void> {
  const persisted = pickPersistent(state);
  const json = JSON.stringify(persisted);
  await invoke("state_save", { content: json });
}

export async function loadState(): Promise<Partial<AppState> | null> {
  const raw = await invoke<string | null>("state_load");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== PERSISTENCE_VERSION) {
      // Older schemas dropped on the floor — INITIAL_STATE wins.
      return null;
    }
    const {
      projects,
      projectOrder,
      worktrees,
      tabs,
      activeProjectId,
      activeWorktreeByProject,
      archivedWorktrees,
      sidebarCollapsed,
      rightPanelCollapsed,
      settings,
      markdownView,
    } = parsed;
    return {
      projects,
      projectOrder,
      worktrees,
      tabs,
      activeProjectId,
      activeWorktreeByProject,
      archivedWorktrees,
      sidebarCollapsed,
      rightPanelCollapsed,
      // Older v2 blobs predate the settings field; fall back to defaults
      // and merge any persisted overrides on top.
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      markdownView,
    };
  } catch {
    return null;
  }
}

export async function clearState(): Promise<void> {
  await invoke("state_clear");
}
