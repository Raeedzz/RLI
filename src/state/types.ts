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
}

export interface OpenFile {
  path: string;
  content: string;
}

export interface AppState {
  projects: Project[];
  sessions: Session[];
  activeProjectId: ProjectId | null;
  activeSessionByProject: Record<ProjectId, SessionId | null>;
  openFile: OpenFile | null;
  paletteOpen: boolean;
  fileTreeVisible: boolean;
  connectionsVisible: boolean;
  searchOpen: boolean;
  browserVisible: boolean;
  apiKeyDialogOpen: boolean;
  /** Root of the dynamic split tree (everything to the right of the file tree). */
  workspace: PaneNode;
}

export type AppAction =
  | { type: "set-active-project"; id: ProjectId }
  | { type: "add-project"; project: Project }
  | { type: "remove-project"; id: ProjectId }
  | { type: "set-active-session"; projectId: ProjectId; sessionId: SessionId }
  | { type: "toggle-palette" }
  | { type: "set-palette"; open: boolean }
  | { type: "toggle-file-tree" }
  | { type: "toggle-connections" }
  | { type: "set-connections"; visible: boolean }
  | { type: "toggle-search" }
  | { type: "set-search"; open: boolean }
  | { type: "toggle-browser" }
  | { type: "set-browser"; visible: boolean }
  | { type: "toggle-api-key" }
  | { type: "set-api-key-dialog"; open: boolean }
  | { type: "open-file"; file: OpenFile }
  | { type: "close-file" }
  | { type: "add-session"; session: Session }
  | { type: "remove-session"; id: SessionId }
  | { type: "update-session"; id: SessionId; patch: Partial<Session> }
  | { type: "set-project-color"; id: ProjectId; color: TagId | undefined }
  | { type: "set-session-color"; id: SessionId; color: TagId | undefined }
  | { type: "reorder-projects"; ids: ProjectId[] }
  | { type: "reorder-sessions"; projectId: ProjectId; ids: SessionId[] }
  | {
      type: "split-pane";
      paneId: PaneNodeId;
      direction: SplitDirection;
      content: PaneContent;
    }
  | { type: "close-pane"; paneId: PaneNodeId }
  | { type: "set-pane-content"; paneId: PaneNodeId; content: PaneContent }
  | { type: "swap-panes"; aId: PaneNodeId; bId: PaneNodeId };
