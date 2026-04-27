import { describe, expect, test } from "bun:test";
import { INITIAL_STATE, reducer } from "./AppState";
import { defaultWorkspaceWithEditor, makeLeaf } from "./paneTree";
import type { AppState, Session } from "./types";

const A_PROJECT = INITIAL_STATE.projects[0];

function makeSession(id: string, name: string): Session {
  return {
    id,
    projectId: A_PROJECT.id,
    name,
    subtitle: "",
    branch: "main",
    status: "idle",
    createdAt: 0,
    workspace: defaultWorkspaceWithEditor(),
    openFile: null,
  };
}

function withTwoSessions(): AppState {
  let state = INITIAL_STATE;
  state = reducer(state, {
    type: "add-session",
    session: makeSession("s_a", "alpha"),
  });
  state = reducer(state, {
    type: "add-session",
    session: makeSession("s_b", "beta"),
  });
  return state;
}

describe("session-scoped workspace reducer", () => {
  test("add-session populates a workspace tree on the new session", () => {
    const state = reducer(INITIAL_STATE, {
      type: "add-session",
      session: makeSession("s_new", "new"),
    });
    const fresh = state.sessions.find((s) => s.id === "s_new");
    expect(fresh).toBeDefined();
    expect(fresh!.workspace).toBeDefined();
    expect(fresh!.openFile).toBe(null);
  });

  test("split-pane only mutates the targeted session's workspace", () => {
    const state = withTwoSessions();
    const a = state.sessions.find((s) => s.id === "s_a")!;
    const b = state.sessions.find((s) => s.id === "s_b")!;
    // Grab the first leaf id of session A
    const aFirstLeafId =
      a.workspace.kind === "split"
        ? (a.workspace.children[0] as { id: string }).id
        : a.workspace.id;

    const next = reducer(state, {
      type: "split-pane",
      sessionId: "s_a",
      paneId: aFirstLeafId,
      direction: "right",
      content: "browser",
    });

    const nextA = next.sessions.find((s) => s.id === "s_a")!;
    const nextB = next.sessions.find((s) => s.id === "s_b")!;
    // A changed
    expect(nextA.workspace).not.toBe(a.workspace);
    // B identical-by-reference (no re-render needed)
    expect(nextB).toBe(b);
    expect(nextB.workspace).toBe(b.workspace);
  });

  test("open-file routes to the targeted session and leaves others untouched", () => {
    const state = withTwoSessions();
    const next = reducer(state, {
      type: "open-file",
      sessionId: "s_a",
      file: { path: "/tmp/foo.rs", content: "fn main(){}" },
    });
    const nextA = next.sessions.find((s) => s.id === "s_a")!;
    const nextB = next.sessions.find((s) => s.id === "s_b")!;
    expect(nextA.openFile?.path).toBe("/tmp/foo.rs");
    expect(nextB.openFile).toBe(null);
    // Untargeted session is identical-by-reference
    const prevB = state.sessions.find((s) => s.id === "s_b")!;
    expect(nextB).toBe(prevB);
  });

  test("close-file clears only the targeted session's openFile", () => {
    let state = withTwoSessions();
    state = reducer(state, {
      type: "open-file",
      sessionId: "s_a",
      file: { path: "/x.rs", content: "" },
    });
    state = reducer(state, {
      type: "open-file",
      sessionId: "s_b",
      file: { path: "/y.rs", content: "" },
    });
    const next = reducer(state, { type: "close-file", sessionId: "s_a" });
    const nextA = next.sessions.find((s) => s.id === "s_a")!;
    const nextB = next.sessions.find((s) => s.id === "s_b")!;
    expect(nextA.openFile).toBe(null);
    expect(nextB.openFile?.path).toBe("/y.rs");
  });

  test("set-pane-content mutates only the targeted session", () => {
    const state = withTwoSessions();
    const a = state.sessions.find((s) => s.id === "s_a")!;
    const aFirstLeafId =
      a.workspace.kind === "split"
        ? (a.workspace.children[0] as { id: string }).id
        : a.workspace.id;

    const next = reducer(state, {
      type: "set-pane-content",
      sessionId: "s_a",
      paneId: aFirstLeafId,
      content: "browser",
    });
    const nextA = next.sessions.find((s) => s.id === "s_a")!;
    const nextB = next.sessions.find((s) => s.id === "s_b")!;
    expect(nextA.workspace).not.toBe(a.workspace);
    const prevB = state.sessions.find((s) => s.id === "s_b")!;
    expect(nextB).toBe(prevB);
  });

  test("hydrate replaces persistent state and leaves transient flags intact", () => {
    // Open the palette + file tree first; hydrate must not nuke them.
    let state = INITIAL_STATE;
    state = reducer(state, { type: "set-palette", open: true });
    state = reducer(state, { type: "set-search", open: true });

    const project = { ...A_PROJECT, id: "p_x", name: "x", path: "/x" };
    const session: Session = {
      ...makeSession("s_x", "x"),
      projectId: project.id,
    };
    const next = reducer(state, {
      type: "hydrate",
      projects: [project],
      sessions: [session],
      activeProjectId: project.id,
      activeSessionByProject: { [project.id]: session.id },
    });

    expect(next.projects.length).toBe(1);
    expect(next.projects[0].id).toBe("p_x");
    expect(next.sessions[0].id).toBe("s_x");
    expect(next.activeProjectId).toBe("p_x");
    expect(next.activeSessionByProject["p_x"]).toBe("s_x");
    // Transient flags survive hydration so we don't briefly flash a
    // closed palette/search bar after the snapshot loads.
    expect(next.paletteOpen).toBe(true);
    expect(next.searchOpen).toBe(true);
  });

  test("close-pane on a 2-pane session collapses to the sibling", () => {
    // Use a fresh state with a 2-pane workspace
    const single = makeLeaf("terminal", "T");
    const sessionId = "s_single";
    let state: AppState = {
      ...INITIAL_STATE,
      sessions: [
        {
          ...makeSession(sessionId, "single"),
          workspace: {
            kind: "split",
            id: "split",
            direction: "horizontal",
            children: [single, makeLeaf("editor", "E")],
          },
        },
      ],
      activeSessionByProject: {
        ...INITIAL_STATE.activeSessionByProject,
        [A_PROJECT.id]: sessionId,
      },
    };
    state = reducer(state, {
      type: "close-pane",
      sessionId,
      paneId: "T",
    });
    const s = state.sessions.find((x) => x.id === sessionId)!;
    expect(s.workspace.kind).toBe("leaf");
    if (s.workspace.kind === "leaf") {
      expect(s.workspace.id).toBe("E");
    }
  });
});
