import {
  createContext,
  useContext,
  useReducer,
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
  setLeafContent,
  splitLeaf,
  swapLeaves,
} from "./paneTree";

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
};

const INITIAL_STATE: AppState = {
  projects: [DEFAULT_PROJECT],
  sessions: [DEFAULT_SESSION],
  activeProjectId: DEFAULT_PROJECT.id,
  activeSessionByProject: {
    [DEFAULT_PROJECT.id]: DEFAULT_SESSION.id,
  },
  openFile: null,
  paletteOpen: false,
  fileTreeVisible: true,
  connectionsVisible: false,
  searchOpen: false,
  browserVisible: false,
  apiKeyDialogOpen: false,
  workspace: defaultWorkspaceWithEditor(),
};

/* ------------------------------------------------------------------
   Reducer
   ------------------------------------------------------------------ */

function reducer(state: AppState, action: AppAction): AppState {
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

    case "toggle-file-tree":
      return { ...state, fileTreeVisible: !state.fileTreeVisible };

    case "toggle-connections":
      return { ...state, connectionsVisible: !state.connectionsVisible };

    case "set-connections":
      return { ...state, connectionsVisible: action.visible };

    case "toggle-search":
      return { ...state, searchOpen: !state.searchOpen };

    case "set-search":
      return { ...state, searchOpen: action.open };

    case "toggle-browser":
      return { ...state, browserVisible: !state.browserVisible };

    case "set-browser":
      return { ...state, browserVisible: action.visible };

    case "toggle-api-key":
      return { ...state, apiKeyDialogOpen: !state.apiKeyDialogOpen };

    case "set-api-key-dialog":
      return { ...state, apiKeyDialogOpen: action.open };

    case "open-file":
      return { ...state, openFile: action.file };

    case "close-file":
      return { ...state, openFile: null };

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
      return {
        ...state,
        workspace: splitLeaf(
          state.workspace,
          action.paneId,
          action.direction,
          action.content,
        ),
      };

    case "close-pane":
      return {
        ...state,
        workspace: closeLeaf(state.workspace, action.paneId),
      };

    case "set-pane-content":
      return {
        ...state,
        workspace: setLeafContent(
          state.workspace,
          action.paneId,
          action.content,
        ),
      };

    case "swap-panes":
      return {
        ...state,
        workspace: swapLeaves(state.workspace, action.aId, action.bId),
      };
  }
}

/* ------------------------------------------------------------------
   Context
   ------------------------------------------------------------------ */

const AppStateContext = createContext<AppState | null>(null);
const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

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
