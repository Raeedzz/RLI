import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getAltScreen,
  getBellTick,
  getBlocks,
  getCwd,
  getExited,
  getLiveFrame,
  getRows,
  setAltScreen as memSetAltScreen,
  setBellTick as memSetBellTick,
  setBlocks as memSetBlocks,
  setCwd as memSetCwd,
  setExited as memSetExited,
  setLiveFrame as memSetLiveFrame,
  setRows as memSetRows,
} from "./sessionMemory";
import type {
  Block,
  ClosedBlock,
  DirtyRow,
  RenderFrame,
  Span,
} from "./types";

interface Args {
  /** Stable PTY session id — must be unique per running PTY. */
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  /** Initial size in cells. The hook re-emits term_resize on container resize. */
  rows: number;
  cols: number;
  /**
   * Active project id, forwarded to term_start so the PTY's env gets
   * `RLI_PROJECT_ID` set. In-pane agents (claude, codex) and the
   * `rli-memory` CLI use this to scope memory operations to the
   * current project without the user passing flags. Optional.
   */
  projectId?: string;
  /** Active session id. Mirrors `RLI_SESSION_ID` injection in PTY env. */
  sessionId?: string;
}

interface SessionApi {
  blocks: Block[];
  liveFrame: RenderFrame | null;
  altScreen: boolean;
  exited: boolean;
  /**
   * Live terminal cwd — updates as the shell emits OSC 7 `cd` reports.
   * Null until the integration script's initial `_rli_chpwd` fires.
   * Consumers should fall back to the static launch cwd while null.
   */
  cwd: string | null;
  /** Bell event counter — increments on every BEL. Frontend animates on diff. */
  bellTick: number;
  /** Submit a line + trailing \n. Used by the block-mode prompt input. */
  sendLine: (text: string) => Promise<void>;
  /** Send raw bytes (passthrough for ⌃C, alt-screen keystrokes, etc.). */
  sendBytes: (bytes: Uint8Array) => Promise<void>;
  /** Tell Rust the cell-grid size changed. */
  resize: (rows: number, cols: number) => Promise<void>;
}

const encoder = new TextEncoder();

/**
 * Lifecycle owner for one terminal session.
 *
 *   - Mount  → invoke `term_start`; listen for frame, block, alt-screen,
 *              bell, exit events.
 *   - Update → keep `liveFrame` (rolling render of in-flight rows) and
 *              `blocks` (closed-block log) in React state.
 *   - Unmount → invoke `term_close`, drop listeners.
 *
 * Frame events arrive throttled to ~60 Hz from Rust; we apply them to the
 * Map<rowIndex, Span[]> in `frameRowsRef`, then push the merged frame
 * to React state. We keep the rows in a ref to avoid re-rendering when
 * only off-screen rows change.
 */
export function useTerminalSession(opts: Args): SessionApi {
  // Hydrate from module-scoped memory so switching sessions/projects
  // doesn't wipe scrollback OR the live grid. Memory is keyed by
  // terminal id and survives the component's React lifecycle.
  const [blocks, setBlocks] = useState<Block[]>(() => getBlocks(opts.id));
  const [liveFrame, setLiveFrame] = useState<RenderFrame | null>(() =>
    getLiveFrame(opts.id),
  );
  const [altScreen, setAltScreen] = useState<boolean>(() => getAltScreen(opts.id));
  const [exited, setExited] = useState<boolean>(() => getExited(opts.id));
  const [cwd, setCwd] = useState<string | null>(() => getCwd(opts.id));
  const [bellTick, setBellTick] = useState<number>(() => getBellTick(opts.id));
  // Snapshot of every row's spans, keyed by row index. Hydrated from
  // memory so the visible grid is preserved across remounts. We then
  // mutate it in place on each frame and shallow-copy into
  // liveFrame.dirty for React. Memory holds the canonical copy.
  const rowsRef = useRef<Span[][]>(getRows(opts.id));
  // Latest frame metadata (cursor + alt-screen flag).
  const lastFrameRef = useRef<RenderFrame | null>(getLiveFrame(opts.id));
  // FIFO of commands the user has submitted via sendLine but whose
  // closing OSC 133 D event hasn't arrived yet. The Rust segmenter
  // doesn't capture user input (we omit the OSC 133 B marker on
  // purpose because zsh's line editor makes the byte stream between
  // B and C unreliable), so the frontend stamps block.input from
  // this queue when each block closes.
  const pendingInputsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: UnlistenFn[] = [];
    // Reset the pending-input queue for THIS effect run. The other
    // local state (rows, frame, blocks, etc.) is intentionally NOT
    // wiped — the user wants to come back to whatever the terminal
    // was showing. Hydration already happened in useState init.
    pendingInputsRef.current = [];

    const onFrame = (frame: RenderFrame) => {
      if (cancelled) return;
      // Splice dirty rows into the row map.
      const rows = rowsRef.current;
      while (rows.length < frame.rows) rows.push([]);
      while (rows.length > frame.rows) rows.pop();
      for (const dr of frame.dirty as DirtyRow[]) {
        rows[dr.row] = dr.spans;
      }
      lastFrameRef.current = frame;
      setAltScreen(frame.alt_screen);
      memSetAltScreen(opts.id, frame.alt_screen);
      // Pushing the full row snapshot every frame for now; dirty-only
      // optimization can land in a follow-up if React reconciliation
      // shows up in profiles.
      const allDirty: DirtyRow[] = rows.map((spans, i) => ({ row: i, spans }));
      const merged: RenderFrame = {
        ...frame,
        dirty: allDirty,
      };
      setLiveFrame(merged);
      // Persist for cross-mount survival. Rows ref is stored by
      // reference (we mutate it in place), so memory observes the
      // updates without an explicit copy.
      memSetLiveFrame(opts.id, merged);
      memSetRows(opts.id, rows);
    };

    const onBlock = (b: ClosedBlock) => {
      if (cancelled) return;
      // Drain one entry from the pending queue — its order is
      // guaranteed by the order in which the user pressed Enter.
      const stamped = pendingInputsRef.current.shift() ?? b.input;
      setBlocks((prev) => {
        const next = [
          ...prev,
          {
            id: `b_${Date.now().toString(36)}_${prev.length}`,
            input: stamped,
            transcript: b.transcript,
            exit_code: b.exit_code,
            cwd: b.cwd,
            durationMs: b.durationMs,
          },
        ];
        memSetBlocks(opts.id, next);
        return next;
      });
    };

    const onCwd = (path: string) => {
      if (cancelled) return;
      setCwd(path);
      memSetCwd(opts.id, path);
    };

    const onBell = () => {
      if (cancelled) return;
      setBellTick((n) => {
        const next = n + 1;
        memSetBellTick(opts.id, next);
        return next;
      });
    };

    const onExit = () => {
      if (cancelled) return;
      setExited(true);
      memSetExited(opts.id, true);
    };

    (async () => {
      try {
        unlisten.push(
          await listen<RenderFrame>(`term://${opts.id}/frame`, (e) =>
            onFrame(e.payload),
          ),
        );
        unlisten.push(
          await listen<ClosedBlock>(`term://${opts.id}/block`, (e) =>
            onBlock(e.payload),
          ),
        );
        unlisten.push(
          await listen<string>(`term://${opts.id}/cwd`, (e) =>
            onCwd(e.payload),
          ),
        );
        unlisten.push(
          await listen(`term://${opts.id}/bell`, onBell),
        );
        unlisten.push(
          await listen(`term://${opts.id}/exit`, onExit),
        );

        await invoke("term_start", {
          args: {
            id: opts.id,
            command: opts.command,
            args: opts.args ?? [],
            cwd: opts.cwd,
            rows: opts.rows,
            cols: opts.cols,
            project_id: opts.projectId,
            session_id: opts.sessionId,
          },
        });
      } catch (err) {
        // Surface as a synthetic block so the user sees the error.
        if (!cancelled) {
          setBlocks((prev) => {
            const next = [
              ...prev,
              {
                id: `err_${Date.now().toString(36)}`,
                input: "",
                transcript: `error starting terminal: ${String(err)}`,
                exit_code: 1,
                cwd: null,
                durationMs: null,
              },
            ];
            memSetBlocks(opts.id, next);
            return next;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of unlisten) fn();
      // We deliberately do NOT call term_close here — the PTY needs to
      // survive a session/project switch so the user comes back to
      // their work. PTYs are torn down only when the session is
      // permanently deleted, via forgetSession() in sessionMemory.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.id, opts.command, JSON.stringify(opts.args), opts.cwd]);

  const sendBytes = async (bytes: Uint8Array) => {
    await invoke("term_input", {
      id: opts.id,
      data: Array.from(bytes),
    });
  };

  const sendLine = async (text: string) => {
    // Push to the pending queue BEFORE sending bytes — there's a real
    // (if tiny) chance the block-close event lands before this function
    // resolves on a fast machine, so the queue must be primed first.
    pendingInputsRef.current.push(text);
    const bytes = encoder.encode(text + "\n");
    await sendBytes(bytes);
  };

  const resize = async (rows: number, cols: number) => {
    await invoke("term_resize", { id: opts.id, rows, cols });
  };

  return {
    blocks,
    liveFrame,
    altScreen,
    exited,
    cwd,
    bellTick,
    sendLine,
    sendBytes,
    resize,
  };
}
