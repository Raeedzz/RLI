import { useEffect, useMemo, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppState } from "@/state/AppState";
import { useAnyTerminalRunning } from "@/terminal/terminalActivityStore";

/**
 * Singleton, app-lifetime-scoped store that drives the sidebar/tab
 * spinner. Source of truth: Claude Code's native hook system. The
 * Rust side installs a small shell script into `~/.claude/hooks/`,
 * registers it for every interesting event (UserPromptSubmit,
 * PreToolUse, Stop, …), and forwards each fired event to a Unix
 * socket. The socket server normalizes the event into a
 * `SessionStatus` and emits a `claude://session/state` Tauri event
 * that this store listens for.
 *
 * Replaces the prior transcript-mtime polling approach: hooks are
 * push-based so we know the exact moment a turn starts and the exact
 * moment it ends, with no 300 ms poll-window jitter. We also see
 * states polling can't see — `Compacting` (auto-summarization in
 * progress) and `Waiting` (paused on a permission prompt).
 *
 * Architecture:
 *
 *   Claude Code  ─[hook event]─▶  ~/.claude/hooks/gli-claude-hook.sh
 *                                         │  (JSON envelope)
 *                                         ▼
 *                              /tmp/gli-claude.sock
 *                                         │
 *                                         ▼
 *                            Rust ClaudeHookState (HashMap by session_id)
 *                                         │
 *                                         ▼
 *                          "claude://session/state" Tauri event
 *                                         │
 *                                         ▼
 *                          this module's `sessions` Map
 *                                         │
 *                                         ▼
 *                   `useTrackAgentActivity(worktree)` → spinner
 *
 * Worktree mapping happens here in the frontend: each `SessionRecord`
 * carries its `cwd` (set on every hook fire), and we match it to
 * `worktree.path` in `useTrackAgentActivity`. That keeps the Rust
 * side ignorant of worktree state — it just knows about sessions —
 * while the React side can still surface a per-worktree spinner.
 */

type SessionStatus =
  | "working"
  | "compacting"
  | "waiting"
  | "idle"
  | "ended";

/**
 * Per-worktree snapshot. Encoded as a single object so consumers
 * only need ONE `useSyncExternalStore` call — keeping the React
 * hook count stable across renders. (Two separate hooks for "is
 * running" and "has session" caused a `hook.getSnapshot is null`
 * crash during HMR because component instances that mounted with
 * one hook saw two on rerender.)
 */
type WorktreeSpinnerState = {
  /** True when at least one session for this path is working/compacting. */
  running: boolean;
  /** True when ANY session is registered for this path, any status. */
  hasSession: boolean;
};

export interface SessionRecord {
  session_id: string;
  cwd: string;
  status: SessionStatus;
  last_event: string;
  last_tool: string;
  updated_at_ms: number;
}

const sessions = new Map<string, SessionRecord>();
const listeners = new Set<() => void>();
let bootstrapped = false;
let unlistenFn: UnlistenFn | null = null;

function notifyAll() {
  // Bump the generation so the per-path snapshot cache is dropped
  // before any consumer's getSnapshot re-reads. Without this, a
  // consumer would see the cached pre-change value and skip the
  // rerender.
  snapshotGeneration += 1;
  listeners.forEach((fn) => fn());
}

function applyRecord(record: SessionRecord) {
  // Debug: visible in the devtools console so we can confirm hook
  // events are arriving from the Rust socket.
  // eslint-disable-next-line no-console
  console.debug(
    "[claude-hook]",
    record.last_event,
    "→",
    record.status,
    "cwd=",
    record.cwd,
  );
  // SessionEnd / Ended evicts so a long-lived app doesn't accumulate
  // dead sessions. The Rust side already drops Ended from its own
  // map; we mirror that here.
  if (record.status === "ended") {
    if (sessions.delete(record.session_id)) notifyAll();
    return;
  }
  const prev = sessions.get(record.session_id);
  if (
    prev &&
    prev.status === record.status &&
    prev.cwd === record.cwd &&
    prev.last_event === record.last_event &&
    prev.last_tool === record.last_tool
  ) {
    // Mutating updated_at_ms alone never affects any visible state,
    // so skip the rerender it would otherwise force on every event.
    prev.updated_at_ms = record.updated_at_ms;
    return;
  }
  sessions.set(record.session_id, record);
  notifyAll();
}

async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  // Initial snapshot in case the user starts GLI while a Claude
  // session is already mid-turn — the hook events for that turn
  // have already fired and we'd otherwise have nothing in the map
  // until the next event.
  try {
    const initial = await invoke<SessionRecord[]>("claude_sessions");
    for (const rec of initial) sessions.set(rec.session_id, rec);
    if (initial.length) notifyAll();
  } catch {
    // Backend not ready — the listener below will catch up.
  }
  try {
    unlistenFn = await listen<SessionRecord>(
      "claude://session/state",
      (e) => applyRecord(e.payload),
    );
  } catch {
    // Listener bind failure is fatal-but-silent: the rest of the app
    // works without spinners. Surface via console for diagnosis.
    // eslint-disable-next-line no-console
    console.warn("gli claude hook listener bind failed");
  }
}

/**
 * Mount once at app shell level. Lazily bootstraps the listener +
 * initial snapshot on first call; subsequent calls are no-ops.
 */
export function useClaudeHookSubscription(): void {
  useEffect(() => {
    void bootstrap();
    // We deliberately don't unbind on unmount — the listener is
    // app-lifetime. If the AppShell ever unmounts (it doesn't), the
    // Tauri Channel just sits idle until app exit.
    return () => {
      void unlistenFn;
    };
  }, []);
}

/**
 * Path-prefix match. Strips a single trailing slash on both sides so
 * `/foo/bar` and `/foo/bar/` both match, then accepts either an exact
 * equality OR a `cwd` that's a descendant of `worktreePath`. The
 * descendant case matters: a user can run `claude` from any
 * subdirectory of a worktree (e.g. cd into `src/` first) and the
 * hook envelope's cwd will reflect that deeper path. Exact-match
 * would silently drop those events from the spinner.
 */
function cwdMatchesWorktree(cwd: string, worktreePath: string): boolean {
  if (!cwd || !worktreePath) return false;
  const a = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const b = worktreePath.endsWith("/")
    ? worktreePath.slice(0, -1)
    : worktreePath;
  return a === b || a.startsWith(b + "/");
}

/**
 * Compute both spinner-relevant booleans for a worktree path in a
 * single pass over the session map. Cached by `worktreePath` so
 * `useSyncExternalStore` sees a stable reference across renders
 * when the underlying state hasn't changed — required to avoid
 * tear warnings and unnecessary rerenders.
 */
const snapshotCache = new Map<string, WorktreeSpinnerState>();
let snapshotGeneration = 0;
let lastNotifiedGeneration = 0;

function computeSpinnerState(worktreePath: string): WorktreeSpinnerState {
  let running = false;
  let hasSession = false;
  if (worktreePath) {
    for (const rec of sessions.values()) {
      if (!cwdMatchesWorktree(rec.cwd, worktreePath)) continue;
      hasSession = true;
      if (rec.status === "working" || rec.status === "compacting") {
        running = true;
        break;
      }
    }
  }
  return { running, hasSession };
}

function getCachedSpinnerState(worktreePath: string): WorktreeSpinnerState {
  // Invalidate the cache on every state generation bump. We can't
  // selectively invalidate only the paths whose sessions changed
  // because `cwdMatchesWorktree` is a prefix match — any session
  // event can affect multiple worktree paths.
  if (lastNotifiedGeneration !== snapshotGeneration) {
    snapshotCache.clear();
    lastNotifiedGeneration = snapshotGeneration;
  }
  const cached = snapshotCache.get(worktreePath);
  if (cached) return cached;
  const fresh = computeSpinnerState(worktreePath);
  snapshotCache.set(worktreePath, fresh);
  return fresh;
}

function useSpinnerState(worktreePath: string): WorktreeSpinnerState {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => getCachedSpinnerState(worktreePath),
    () => getCachedSpinnerState(worktreePath),
  );
}

/**
 * Spinner signal for a worktree. Two OR'd sources, both push-based:
 *
 *   1. Claude Code hook events (`claude://session/state`). The
 *      authoritative agent signal. Goes "working" on UserPromptSubmit /
 *      PreToolUse and back to "waiting" on Stop / SubagentStop.
 *      Doesn't fire while the agent is idle at its input box.
 *
 *   2. Per-PTY OSC 133 `command_running` (terminalActivityStore).
 *      Catches non-Claude work — `npm run build`, `pytest`, etc.
 *      Toggles off the moment the shell prompt returns.
 *
 * The `worktreeId` arg is kept in the signature for API stability
 * with previous callers; matching happens by `cwd === worktree.path`.
 */
export function useTrackAgentActivity(
  worktreeId: string,
  cwd: string,
): boolean {
  // ONE external-store hook (HMR-safe — hook count stays stable
  // across renders).
  const { running: hookRunning, hasSession: hasHookSession } =
    useSpinnerState(cwd);
  const state = useAppState();
  const worktree = state.worktrees[worktreeId];
  // OSC 133 fallback ids. Tab-level exclusion (`agentStatus`) alone
  // isn't sufficient because with the scoped keepalive layer,
  // background-worktree tabs aren't mounted — their `agentStatus`
  // never flips. The hook-session check below handles that case.
  const ptyIds = useMemo<string[]>(() => {
    if (!worktree) return [];
    const ids: string[] = [];
    for (const tabId of worktree.tabIds) {
      const t = state.tabs[tabId];
      if (!t || t.kind !== "terminal") continue;
      if (t.agentStatus === "running") continue;
      ids.push(t.ptyId);
    }
    return ids;
  }, [worktree, state.tabs]);
  const commandRunning = useAnyTerminalRunning(ptyIds);
  // If there's any Claude hook session for this worktree, trust the
  // hook stream completely and ignore OSC 133 — the `claude` binary
  // keeps OSC 133 `command_running` true for its entire lifetime
  // (including idle at the input prompt), which would pin the
  // spinner on. Only fall back to OSC 133 when no hook session is
  // registered, i.e. pure shell work like `npm run build` / `pytest`
  // where OSC 133 toggles cleanly on command boundaries.
  if (hasHookSession) return hookRunning;
  return commandRunning;
}

// Re-exported for tests / scripts that want to inspect store state.
// Not part of the supported API.
export const __internals = {
  sessions,
  applyRecord,
};
