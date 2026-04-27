export type ProjectId = string;
export type SessionId = string;
export type PaneNodeId = string;

/** What a leaf pane displays. */
export type PaneContent = "terminal" | "editor" | "browser";

/** A direction the user can request when splitting an existing pane. */
export type SplitDirection = "left" | "right" | "up" | "down";

export interface PaneLeaf {
  kind: "leaf";
  id: PaneNodeId;
  content: PaneContent;
}

export interface PaneSplit {
  kind: "split";
  id: PaneNodeId;
  /** "horizontal" splits side-by-side, "vertical" stacks top/bottom. */
  direction: "horizontal" | "vertical";
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

export type SessionStatus = "idle" | "streaming" | "error";

/** Workshop-pigment palette — see tokens.css `--tag-*` */
export type TagId =
  | "default"
  | "rust"
  | "amber"
  | "moss"
  | "pine"
  | "slate"
  | "iris"
  | "rose";

export const TAG_IDS: readonly TagId[] = [
  "default",
  "rust",
  "amber",
  "moss",
  "pine",
  "slate",
  "iris",
  "rose",
];

/** Resolves a TagId (or undefined) to a CSS color expression. */
export function tagVar(tag: TagId | undefined): string {
  return `var(--tag-${tag ?? "default"})`;
}

export interface Project {
  id: ProjectId;
  path: string;
  name: string;
  /** 1–2 character glyph, only used inside dense menu rows. */
  glyph: string;
  pinned: boolean;
  /** User-assigned color tag. Defaults to the system accent if unset. */
  color?: TagId;
}

export interface Session {
  id: SessionId;
  projectId: ProjectId;
  /** Slug-friendly title generated from the user's first prompt to the agent. */
  name: string;
  /** Single-line activity summary — updated by Flash-Lite when agent goes idle. */
  subtitle: string;
  /** Branch name in the project's worktree, e.g. `rli/fix-oauth-redirect-bug`. */
  branch: string;
  status: SessionStatus;
  createdAt: number;
  /** User-assigned color tag. Defaults to the system accent if unset. */
  color?: TagId;
  /** Per-session workspace tree — splits, pane content, layout. */
  workspace: PaneNode;
  /** Currently open file in this session's editor pane(s). */
  openFile: OpenFile | null;
  /**
   * Wall-clock millis at which Claude was first detected in any
   * terminal pane of this session. Drives the 5h-window pill's %
   * and remaining-time math. Null until detection; persists across
   * app restarts (the 5h Anthropic window outlives a relaunch).
   */
  claudeStartedAt?: number | null;
  /**
   * True iff a foreground TUI agent (claude, etc.) is currently
   * running in some terminal pane of this session. Gates whether
   * the global status bar shows the Claude pill — `claudeStartedAt`
   * alone keeps the pill stuck on after the agent exits.
   * Runtime-only (always reset to `false` on persistence).
   */
  agentRunning?: boolean;
}

export interface OpenFile {
  path: string;
  content: string;
}

export type LeftPanel = "files" | "git" | "connections" | null;

export interface AppState {
  projects: Project[];
  sessions: Session[];
  activeProjectId: ProjectId | null;
  activeSessionByProject: Record<ProjectId, SessionId | null>;
  paletteOpen: boolean;
  /**
   * Which side panel is showing on the left. Only one of files / git /
   * connections at a time — clicking a tab in the ActivityRail swaps
   * the slot. `null` hides the left panel entirely.
   */
  leftPanel: LeftPanel;
  searchOpen: boolean;
  apiKeyDialogOpen: boolean;
}

export type AppAction =
  | { type: "set-active-project"; id: ProjectId }
  | { type: "add-project"; project: Project }
  | { type: "remove-project"; id: ProjectId }
  | { type: "set-active-session"; projectId: ProjectId; sessionId: SessionId }
  | { type: "toggle-palette" }
  | { type: "set-palette"; open: boolean }
  | { type: "set-left-panel"; panel: LeftPanel }
  | { type: "toggle-left-panel"; panel: Exclude<LeftPanel, null> }
  | { type: "toggle-search" }
  | { type: "set-search"; open: boolean }
  | { type: "toggle-browser" }
  | { type: "toggle-api-key" }
  | { type: "set-api-key-dialog"; open: boolean }
  | { type: "open-file"; sessionId: SessionId; file: OpenFile }
  | { type: "close-file"; sessionId: SessionId }
  | { type: "add-session"; session: Session }
  | { type: "remove-session"; id: SessionId }
  | { type: "update-session"; id: SessionId; patch: Partial<Session> }
  | { type: "set-project-color"; id: ProjectId; color: TagId | undefined }
  | { type: "set-session-color"; id: SessionId; color: TagId | undefined }
  | { type: "reorder-projects"; ids: ProjectId[] }
  | { type: "reorder-sessions"; projectId: ProjectId; ids: SessionId[] }
  | {
      type: "split-pane";
      sessionId: SessionId;
      paneId: PaneNodeId;
      direction: SplitDirection;
      content: PaneContent;
    }
  | { type: "close-pane"; sessionId: SessionId; paneId: PaneNodeId }
  | {
      type: "set-pane-content";
      sessionId: SessionId;
      paneId: PaneNodeId;
      content: PaneContent;
    }
  | {
      type: "swap-panes";
      sessionId: SessionId;
      aId: PaneNodeId;
      bId: PaneNodeId;
    }
  | {
      /**
       * Relocate a pane next to another pane on a chosen edge. Used by
       * drag-and-drop with edge-zone detection — drop on a target's
       * left/right/up/down edge to land the source on that side.
       */
      type: "move-pane";
      sessionId: SessionId;
      sourceId: PaneNodeId;
      targetId: PaneNodeId;
      direction: SplitDirection;
    }
  | {
      /**
       * Replace the persistent slice (projects, sessions, active pointers)
       * with a snapshot loaded from disk. Transient UI flags (palette,
       * dialogs) are left at their current values so we don't briefly
       * flash open menus on boot. Dispatched once after the store loads.
       */
      type: "hydrate";
      projects: Project[];
      sessions: Session[];
      activeProjectId: ProjectId | null;
      activeSessionByProject: Record<ProjectId, SessionId | null>;
    };
