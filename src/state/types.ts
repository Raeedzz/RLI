export type ProjectId = string;
export type SessionId = string;

export type SessionStatus = "idle" | "streaming" | "error";

export interface Project {
  id: ProjectId;
  path: string;
  name: string;
  /** 1–2 character glyph displayed in the project rail icon */
  glyph: string;
  pinned: boolean;
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
}

export interface AppState {
  projects: Project[];
  sessions: Session[];
  activeProjectId: ProjectId | null;
  activeSessionByProject: Record<ProjectId, SessionId | null>;
  paletteOpen: boolean;
  fileTreeVisible: boolean;
}

export type AppAction =
  | { type: "set-active-project"; id: ProjectId }
  | { type: "set-active-session"; projectId: ProjectId; sessionId: SessionId }
  | { type: "toggle-palette" }
  | { type: "set-palette"; open: boolean }
  | { type: "toggle-file-tree" }
  | { type: "add-session"; session: Session }
  | { type: "remove-session"; id: SessionId }
  | { type: "update-session"; id: SessionId; patch: Partial<Session> }
  | { type: "reorder-projects"; ids: ProjectId[] }
  | { type: "reorder-sessions"; projectId: ProjectId; ids: SessionId[] };
