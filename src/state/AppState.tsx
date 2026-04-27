import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  AppAction,
  AppState,
  Project,
  Session,
} from "./types";
import {
  closeLeaf,
  defaultWorkspaceWithEditor,
  leaves,
  movePane,
  setLeafContent,
  splitLeaf,
  swapLeaves,
} from "./paneTree";
import { loadState, saveState } from "../lib/persistence";

/* ------------------------------------------------------------------
   Stub data for the v1 visual scaffold. Real persistence + project
   discovery lands in Task #9 (worktree session lifecycle).
   ------------------------------------------------------------------ */

/**
 * Default state on first launch — one real project pointing at the
 * current working directory, one fresh session.
 *
 * The cwd path is set asynchronously after mount in App.tsx; until
 * that resolves we ship a sensible macOS-shaped default that the user
 * can immediately replace with ⌘O.
 */
const DEFAULT_PROJECT: Project = {
  id: "p_default",
  path: "/Users/raeedz/Developer/RLI",
  name: "RLI",
  glyph: "R",
  pinned: false,
};

const DEFAULT_SESSION: Session = {
  id: "s_default",
  projectId: DEFAULT_PROJECT.id,
  name: "session 1",
  subtitle: "ready",
  branch: "main",
  status: "idle",
  createdAt: Date.now(),
  workspace: defaultWorkspaceWithEditor(),
  openFile: null,
};

export const INITIAL_STATE: AppState = {
  projects: [DEFAULT_PROJECT],
  sessions: [DEFAULT_SESSION],
  activeProjectId: DEFAULT_PROJECT.id,
  activeSessionByProject: {
    [DEFAULT_PROJECT.id]: DEFAULT_SESSION.id,
  },
  paletteOpen: false,
  leftPanel: "files",
  searchOpen: false,
  apiKeyDialogOpen: false,
};

/* ------------------------------------------------------------------
   Reducer
   ------------------------------------------------------------------ */

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "set-active-project":
      return { ...state, activeProjectId: action.id };

    case "add-project": {
      const exists = state.projects.find((p) => p.id === action.project.id);
      if (exists) {
        return { ...state, activeProjectId: action.project.id };
      }
      return {
        ...state,
        projects: [...state.projects, action.project],
        activeProjectId: action.project.id,
      };
    }

    case "remove-project": {
      const projects = state.projects.filter((p) => p.id !== action.id);
      const sessions = state.sessions.filter((s) => s.projectId !== action.id);
      const activeProjectId =
        state.activeProjectId === action.id
          ? (projects[0]?.id ?? null)
          : state.activeProjectId;
      return { ...state, projects, sessions, activeProjectId };
    }

    case "set-active-session":
      return {
        ...state,
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [action.projectId]: action.sessionId,
        },
      };

    case "toggle-palette":
      return { ...state, paletteOpen: !state.paletteOpen };

    case "set-palette":
      return { ...state, paletteOpen: action.open };

    case "set-left-panel":
      return { ...state, leftPanel: action.panel };

    case "toggle-left-panel":
      return {
        ...state,
        leftPanel: state.leftPanel === action.panel ? null : action.panel,
      };

    case "toggle-search":
      return { ...state, searchOpen: !state.searchOpen };

    case "set-search":
      return { ...state, searchOpen: action.open };

    case "toggle-browser": {
      // Browser is just another pane — toggle = add or remove a browser
      // leaf in the active session's workspace tree. That gets us the
      // same PaneFrame chrome (drag, split, snap, header) for free.
      const projectId = state.activeProjectId;
      if (!projectId) return state;
      const sessionId = state.activeSessionByProject[projectId];
      if (!sessionId) return state;
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return state;
      const allLeaves = leaves(session.workspace);
      const browserLeaf = allLeaves.find((l) => l.content === "browser");
      const nextWorkspace = browserLeaf
        ? closeLeaf(session.workspace, browserLeaf.id)
        : splitLeaf(
            session.workspace,
            allLeaves[allLeaves.length - 1].id,
            "right",
            "browser",
          );
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, workspace: nextWorkspace } : s,
        ),
      };
    }

    case "toggle-api-key":
      return { ...state, apiKeyDialogOpen: !state.apiKeyDialogOpen };

    case "set-api-key-dialog":
      return { ...state, apiKeyDialogOpen: action.open };

    case "open-file":
      return updateSession(state, action.sessionId, () => ({
        openFile: action.file,
      }));

    case "close-file":
      return updateSession(state, action.sessionId, () => ({
        openFile: null,
      }));

    case "add-session": {
      const next = [...state.sessions, action.session];
      return {
        ...state,
        sessions: next,
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [action.session.projectId]: action.session.id,
        },
      };
    }

    case "remove-session": {
      const target = state.sessions.find((s) => s.id === action.id);
      if (!target) return state;
      const remaining = state.sessions.filter((s) => s.id !== action.id);
      const sameProject = remaining.filter(
        (s) => s.projectId === target.projectId,
      );
      const wasActive =
        state.activeSessionByProject[target.projectId] === action.id;
      return {
        ...state,
        sessions: remaining,
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [target.projectId]: wasActive
            ? sameProject[0]?.id ?? null
            : state.activeSessionByProject[target.projectId],
        },
      };
    }

    case "update-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, ...action.patch } : s,
        ),
      };

    case "set-project-color":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.id ? { ...p, color: action.color } : p,
        ),
      };

    case "set-session-color":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, color: action.color } : s,
        ),
      };

    case "reorder-projects":
      return {
        ...state,
        projects: action.ids
          .map((id) => state.projects.find((p) => p.id === id))
          .filter((p): p is Project => p != null),
      };

    case "reorder-sessions": {
      const ordered = action.ids
        .map((id) => state.sessions.find((s) => s.id === id))
        .filter((s): s is Session => s != null);
      const others = state.sessions.filter(
        (s) => s.projectId !== action.projectId,
      );
      return { ...state, sessions: [...others, ...ordered] };
    }

    case "split-pane":
      return updateSession(state, action.sessionId, (s) => ({
        workspace: splitLeaf(
          s.workspace,
          action.paneId,
          action.direction,
          action.content,
        ),
      }));

    case "close-pane":
      return updateSession(state, action.sessionId, (s) => ({
        workspace: closeLeaf(s.workspace, action.paneId),
      }));

    case "set-pane-content":
      return updateSession(state, action.sessionId, (s) => ({
        workspace: setLeafContent(
          s.workspace,
          action.paneId,
          action.content,
        ),
      }));

    case "swap-panes":
      return updateSession(state, action.sessionId, (s) => ({
        workspace: swapLeaves(s.workspace, action.aId, action.bId),
      }));

    case "move-pane":
      return updateSession(state, action.sessionId, (s) => ({
        workspace: movePane(
          s.workspace,
          action.sourceId,
          action.targetId,
          action.direction,
        ),
      }));

    case "hydrate":
      return {
        ...state,
        projects: action.projects,
        sessions: action.sessions,
        activeProjectId: action.activeProjectId,
        activeSessionByProject: action.activeSessionByProject,
      };
  }
}

/**
 * Apply a partial update to one session by id. Used by pane and file
 * mutations so non-targeted sessions keep their reference (React skips
 * re-renders that depend on them).
 */
function updateSession(
  state: AppState,
  sessionId: string,
  patch: (s: Session) => Partial<Session>,
): AppState {
  let changed = false;
  const next = state.sessions.map((s) => {
    if (s.id !== sessionId) return s;
    changed = true;
    return { ...s, ...patch(s) };
  });
  if (!changed) return state;
  return { ...state, sessions: next };
}

/* ------------------------------------------------------------------
   Context
   ------------------------------------------------------------------ */

const AppStateContext = createContext<AppState | null>(null);
const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null);

/**
 * Debounce window for autosave. 400 ms is short enough that a Cmd-Q
 * after a change still flushes (Tauri's window-close fires the unload
 * event after this) but long enough that rapid pane shuffling doesn't
 * pin the disk.
 */
const SAVE_DEBOUNCE_MS = 400;

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  // Suppress the autosave that would otherwise fire immediately after
  // the hydrate dispatch (no real change, but still a state transition).
  const hydratedRef = useRef(false);

  // Hydrate on mount — fire-and-forget. If load fails or there's no
  // saved state, the INITIAL_STATE default sticks.
  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((persisted) => {
        if (cancelled || !persisted) {
          hydratedRef.current = true;
          return;
        }
        dispatch({
          type: "hydrate",
          projects: persisted.projects,
          sessions: persisted.sessions,
          activeProjectId: persisted.activeProjectId,
          activeSessionByProject: persisted.activeSessionByProject,
        });
        // Mark hydrated AFTER the dispatch lands so the save effect
        // that observes the post-hydrate state doesn't re-write the
        // same blob.
        requestAnimationFrame(() => {
          hydratedRef.current = true;
        });
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save the persistent slice whenever it changes — debounced.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const timer = window.setTimeout(() => {
      saveState(state).catch(() => {
        // Best-effort. A failed save shouldn't crash the app; the next
        // change retries automatically. We could surface a toast once
        // we have toast infra, but persistent failures here are rare
        // (write-protected app data dir is the only realistic cause).
      });
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    state.projects,
    state.sessions,
    state.activeProjectId,
    state.activeSessionByProject,
  ]);

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        {children}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) {
    throw new Error("useAppState must be used inside <AppStateProvider>");
  }
  return state;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(AppDispatchContext);
  if (!dispatch) {
    throw new Error("useAppDispatch must be used inside <AppStateProvider>");
  }
  return dispatch;
}

/* ------------------------------------------------------------------
   Convenience selectors
   ------------------------------------------------------------------ */

export function useActiveProject(): Project | null {
  const state = useAppState();
  if (!state.activeProjectId) return null;
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null;
}

export function useProjectSessions(projectId: string | null): Session[] {
  const state = useAppState();
  if (!projectId) return [];
  return state.sessions.filter((s) => s.projectId === projectId);
}

export function useActiveSession(): Session | null {
  const state = useAppState();
  if (!state.activeProjectId) return null;
  const sessionId = state.activeSessionByProject[state.activeProjectId];
  if (!sessionId) return null;
  return state.sessions.find((s) => s.id === sessionId) ?? null;
}
