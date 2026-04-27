import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { BlockList } from "./BlockList";
import { FullGrid } from "./FullGrid";
import { LiveBlock } from "./LiveBlock";
import { PromptInput, type PromptInputHandle } from "./PromptInput";
import { PtyPassthrough, type PtyPassthroughHandle } from "./PtyPassthrough";
import { TerminalStatusBar } from "./TerminalStatusBar";
import { useTerminalSession } from "./useTerminalSession";
import { detectClaude } from "@/lib/claudeUsage";

/** Command names that always run as an interactive TUI agent. */
function isAgentCommand(command: string): boolean {
  const c = command.toLowerCase();
  return c === "claude" || c.includes("codex") || c.includes("aider");
}

interface Props {
  /** Stable PTY session ID — must be unique per running PTY. */
  id: string;
  /** Command to spawn (e.g. "zsh", "claude", "codex"). */
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * Fires once when Claude is first detected in this pane's PTY
   * stream (or immediately on mount when `command` is itself an
   * agent). Wired by the parent into a `update-session` dispatch
   * so the global StatusBar can show the 5h-window pill.
   */
  onClaudeDetected?: (timestamp: number) => void;
  /**
   * Fires whenever foregroundIsAgent flips. Parent dispatches this
   * to session state so the StatusBar can hide the Claude pill the
   * moment the agent exits (instead of leaving it stuck on for the
   * remainder of the 5h window).
   */
  onAgentRunningChange?: (running: boolean) => void;
}

const DEFAULT_ROWS = 32;
const DEFAULT_COLS = 100;
const HISTORY_LIMIT = 100;
const BELL_FLASH_MS = 480;

/**
 * Custom block-mode terminal backed by alacritty_terminal in Rust.
 *
 *   ┌────────────────────────────────┐
 *   │  ▓ live + closed blocks (BlockList scrolls bottom-up)  │
 *   ├────────────────────────────────┤
 *   │ [pills row]                     │  TerminalStatusBar
 *   │ Run commands▏                   │  PromptInput textarea
 *   │ ⌘↵ new /agent conversation      │  PromptInput hint
 *   └────────────────────────────────┘
 *
 * When the running shell pushes alt-screen (vim/htop/claude TUI), we
 * swap the BlockList + PromptInput stack for a FullGrid that mirrors
 * the entire grid and forwards every keystroke.
 */
export function BlockTerminal({
  id,
  command,
  args,
  cwd,
  onClaudeDetected,
  onAgentRunningChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<PromptInputHandle>(null);
  const passthroughRef = useRef<PtyPassthroughHandle>(null);
  // In-memory ring buffer of past commands (newest at index 0). Reset
  // on session id change.
  const [history, setHistory] = useState<string[]>([]);
  // For Claude 5h-window detection — sniff the live frame text for
  // the banner; once detected, fire the parent callback so the
  // global StatusBar's pill anchors to that timestamp. Local state
  // mirror so the inline detection logic doesn't fire twice.
  const [claudeDetectedLocal, setClaudeDetectedLocal] = useState(false);
  const sniffBufferRef = useRef("");
  const onClaudeDetectedRef = useRef(onClaudeDetected);
  useEffect(() => {
    onClaudeDetectedRef.current = onClaudeDetected;
  }, [onClaudeDetected]);
  const onAgentRunningChangeRef = useRef(onAgentRunningChange);
  useEffect(() => {
    onAgentRunningChangeRef.current = onAgentRunningChange;
  }, [onAgentRunningChange]);
  // For direct-launched claude sessions, fire the detected callback
  // on mount — there's no banner to sniff because we ARE the agent.
  useEffect(() => {
    if (command.toLowerCase() === "claude" && !claudeDetectedLocal) {
      setClaudeDetectedLocal(true);
      onClaudeDetectedRef.current?.(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // Whether the *currently foregrounded* process is an interactive
  // TUI agent (claude, codex, aider, …). When true the agent renders
  // its own input box inside the live frame, so we hide RLI's
  // PromptInput and route keystrokes through PtyPassthrough instead.
  const directAgent = useMemo(() => isAgentCommand(command), [command]);
  const [foregroundIsAgent, setForegroundIsAgent] = useState(directAgent);

  // Tell the parent (which dispatches into session state) every time
  // the foreground-agent flag flips. Done in an effect rather than
  // inside setForegroundIsAgent calls so we don't have to remember
  // to forward at every callsite.
  const lastReportedAgentRef = useRef(false);
  useEffect(() => {
    if (foregroundIsAgent !== lastReportedAgentRef.current) {
      lastReportedAgentRef.current = foregroundIsAgent;
      onAgentRunningChangeRef.current?.(foregroundIsAgent);
    }
  }, [foregroundIsAgent]);
  // What the user typed to start the currently-running command.
  // Populates the synthetic header on the in-progress LiveBlock; used
  // to trim zsh's command-echo line out of the live grid body so the
  // command doesn't appear twice (header + first body row). Cleared
  // when the OSC 133 D marker fires.
  const [activeCommand, setActiveCommand] = useState<string>(
    directAgent ? command : "",
  );

  const {
    blocks,
    liveFrame,
    altScreen,
    cwd: liveCwd,
    bellTick,
    sendLine,
    sendBytes,
    resize,
  } = useTerminalSession({
    id,
    command,
    args,
    cwd,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
  });

  // `altScreen` covers vim/htop; `foregroundIsAgent` covers
  // claude/codex/etc. that render in the normal screen. Both hide
  // PromptInput + status bar so the agent's own UI owns the surface.
  const agentMode = altScreen || foregroundIsAgent;

  // Bell visualization — a brief, soft pulse on the input zone every
  // time the shell emits BEL. We just track "is currently flashing"
  // and let CSS handle the easing.
  const [bellFlash, setBellFlash] = useState(false);
  useEffect(() => {
    if (bellTick === 0) return;
    setBellFlash(true);
    const t = window.setTimeout(() => setBellFlash(false), BELL_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [bellTick]);

  // Re-fit on container resize OR when we toggle agent mode (since
  // hiding the PromptInput frees ~80px of vertical real estate that
  // the alacritty grid can claim). Translate pixel size → cell grid
  // assuming a fixed monospace metric (13px font @ 1.35 line height).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      // Status bar + textarea + hint ≈ 80px when shown; agent mode
      // hides them so we only reserve a thin gutter.
      const reserved = agentMode ? 8 : 80;
      const usableHeight = Math.max(120, rect.height - reserved);
      const cellHeight = 13 * 1.35;
      const cellWidth = 13 * 0.55; // close enough for monospace
      const rows = Math.max(8, Math.floor(usableHeight / cellHeight));
      const cols = Math.max(20, Math.floor((rect.width - 24) / cellWidth));
      void resize(rows, cols).catch(() => {});
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize, agentMode]);

  // Sniff the live frame for the Claude banner so the 5h usage bar
  // attaches automatically AND we know to hide PromptInput in favor
  // of the agent's own input.
  //
  // CRITICAL: only sniff while a command is actively running. After
  // Ctrl+C kills an agent the alacritty grid still holds the agent's
  // TUI bytes — without this gate, the very next frame after the
  // command_running=false transition would re-detect claude from
  // those leftover bytes and flip foregroundIsAgent back to true,
  // pinning PromptInput off-screen forever.
  useEffect(() => {
    if (foregroundIsAgent) return;
    if (!liveFrame) return;
    if (!liveFrame.command_running) return;
    const text = liveFrame.dirty
      .map((dr) => dr.spans.map((s) => s.text).join(""))
      .join("\n");
    sniffBufferRef.current = (sniffBufferRef.current + text).slice(-16_384);
    if (detectClaude(sniffBufferRef.current)) {
      setForegroundIsAgent(true);
      if (!claudeDetectedLocal) {
        setClaudeDetectedLocal(true);
        onClaudeDetectedRef.current?.(Date.now());
      }
      sniffBufferRef.current = "";
    }
  }, [liveFrame, foregroundIsAgent, claudeDetectedLocal]);


  const onSubmit = useCallback(
    (text: string) => {
      setActiveCommand(text);
      void sendLine(text);
      if (text.trim().length > 0) {
        setHistory((prev) => [text, ...prev].slice(0, HISTORY_LIMIT));
      }
    },
    [sendLine],
  );

  // Track previous command_running so we only react to the
  // running→idle TRANSITION for activeCommand. The naive "reset
  // when not running" version fired on the very first render after
  // onSubmit (because OSC 133 C hadn't arrived yet → command_running
  // was still false), wiping the activeCommand the user just typed.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (directAgent) return;
    if (!liveFrame) return;
    const wasRunning = prevRunningRef.current;
    const isRunning = liveFrame.command_running;
    prevRunningRef.current = isRunning;
    if (wasRunning && !isRunning) {
      if (activeCommand.length > 0) setActiveCommand("");
      sniffBufferRef.current = "";
      setTimeout(() => promptRef.current?.focus(), 0);
    }
  }, [liveFrame?.command_running, activeCommand, directAgent]);

  // Belt-and-suspenders: any time the live frame says no command is
  // running yet `foregroundIsAgent` is somehow still true (e.g. the
  // running flag flipped before the activeCommand transition could
  // catch it, or a stale state survived a session swap), force-exit
  // agent mode. Direct agents stay pinned for the lifetime of the
  // session.
  useEffect(() => {
    if (directAgent) return;
    if (!liveFrame) return;
    if (!liveFrame.command_running && foregroundIsAgent) {
      setForegroundIsAgent(false);
      sniffBufferRef.current = "";
      setTimeout(() => promptRef.current?.focus(), 0);
    }
  }, [liveFrame?.command_running, foregroundIsAgent, directAgent]);

  // Bracketed-paste passthrough. zsh + most modern shells set DECSET
  // 2004 by default (their line editor strips the markers and treats
  // pasted text literally — no auto-execute on embedded \n). We wrap
  // the pasted bytes in OSC 200/201 so multi-line pastes don't run
  // line-by-line as separate commands.
  const onPaste = useCallback(
    (text: string) => {
      const PS = "\x1b[200~";
      const PE = "\x1b[201~";
      const enc = new TextEncoder();
      void sendBytes(enc.encode(`${PS}${text}${PE}`));
    },
    [sendBytes],
  );

  const historyAt = useCallback(
    (offset: number) => history[offset] ?? null,
    [history],
  );

  // Don't steal focus from a text selection. Click on a block to copy
  // → the selection survives. Click into empty terminal space → focus
  // the active input (PromptInput in shell mode, PtyPassthrough in
  // agent mode) so typing "just works".
  const onContainerMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) {
      return;
    }
    // Only refocus on plain left-clicks; right-click opens context menus.
    if (e.button !== 0) return;
    if (foregroundIsAgent) {
      passthroughRef.current?.focus();
    } else {
      promptRef.current?.focus();
    }
  };

  const effectiveCwd = liveCwd ?? cwd ?? "";

  return (
    <div
      ref={containerRef}
      onMouseUp={onContainerMouseUp}
      data-bell-flash={bellFlash ? "1" : undefined}
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        position: "relative",
        // Soft warm pulse when the terminal rings the bell. CSS handles
        // the easing so the runtime cost is one class flip.
        boxShadow: bellFlash
          ? "inset 0 0 0 1px var(--state-warning)"
          : undefined,
        transition: "box-shadow 480ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {altScreen ? (
        <FullGrid frame={liveFrame} onSendBytes={sendBytes} />
      ) : (
        <BlockList blocks={blocks} />
      )}

      {!altScreen && (liveFrame?.command_running || directAgent) && (
        <LiveBlock command={activeCommand} frame={liveFrame} />
      )}

      {!altScreen && effectiveCwd && (
        <TerminalStatusBar cwd={effectiveCwd} command={command} />
      )}
      {!agentMode && (
        <PromptInput
          ref={promptRef}
          onSubmit={onSubmit}
          onSendBytes={(b) => void sendBytes(b)}
          onPaste={onPaste}
          historyLength={history.length}
          historyAt={historyAt}
          cwd={effectiveCwd}
        />
      )}
      {foregroundIsAgent && !altScreen && (
        <PtyPassthrough
          ref={passthroughRef}
          onSendBytes={(b) => void sendBytes(b)}
        />
      )}
    </div>
  );
}
