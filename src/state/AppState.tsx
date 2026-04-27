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

/* ------------------------------------------------------------------
   Stub data for the v1 visual scaffold. Real persistence + project
   discovery lands in Task #9 (worktree session lifecycle).
   ------------------------------------------------------------------ */

const STUB_PROJECTS: Project[] = [
  {
    id: "p_rli",
    path: "/Users/raeedz/Developer/RLI",
    name: "RLI",
    glyph: "R",
    pinned: true,
  },
  {
    id: "p_sckry",
    path: "/Users/raeedz/Developer/sckry",
    name: "sckry",
    glyph: "S",
    pinned: false,
  },
];

const STUB_SESSIONS: Session[] = [
  {
    id: "s_oauth",
    projectId: "p_rli",
    name: "fix oauth redirect bug",
    subtitle: "Refactoring AuthProvider to handle expired refresh tokens",
    branch: "rli/fix-oauth-redirect-bug",
    status: "streaming",
    createdAt: Date.now() - 1000 * 60 * 14,
  },
  {
    id: "s_docs",
    projectId: "p_rli",
    name: "rewrite getting started docs",
    subtitle: "Reading existing README and docs/ for context",
    branch: "rli/rewrite-getting-started",
    status: "idle",
    createdAt: Date.now() - 1000 * 60 * 4,
  },
];

const INITIAL_STATE: AppState = {
  projects: STUB_PROJECTS,
  sessions: STUB_SESSIONS,
  activeProjectId: STUB_PROJECTS[0].id,
  activeSessionByProject: {
    [STUB_PROJECTS[0].id]: STUB_SESSIONS[0].id,
  },
  paletteOpen: false,
  fileTreeVisible: true,
};

/* ------------------------------------------------------------------
   Reducer
   ------------------------------------------------------------------ */

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "set-active-project":
      return { ...state, activeProjectId: action.id };

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
