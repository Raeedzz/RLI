import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { BlockList } from "./BlockList";
import { CanvasGrid, isCanvasRendererEnabled } from "./CanvasGrid";
import { FullGrid } from "./FullGrid";
import { LiveBlock } from "./LiveBlock";
import { PromptInput, type PromptInputHandle } from "./PromptInput";
import { PtyPassthrough, type PtyPassthroughHandle } from "./PtyPassthrough";
import { TerminalStatusBar } from "./TerminalStatusBar";
import { useTerminalSession } from "./useTerminalSession";
import { getHistory, setHistory as memSetHistory } from "./sessionMemory";
import { detectClaude } from "@/lib/claudeUsage";

/** Command names that always run as an interactive TUI agent. */
function isAgentCommand(command: string): boolean {
  const c = command.toLowerCase();
  return (
    c === "claude" ||
    c.includes("codex") ||
    c.includes("aider") ||
    c === "gemini" ||
    c === "gemini-cli"
  );
}

export type DetectedAgentCli = "claude" | "codex" | "gemini" | null;

/**
 * Classify the CLI invoked by a command line — handles env-var prefixes
 * and absolute-path wrappers. Returns null for non-agent commands.
 */
function detectCliFromCommandLine(line: string): DetectedAgentCli {
  const tokens = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[a-z_][a-z0-9_]*=/i.test(t)) continue;
    const prog = (t.split("/").pop() ?? t).split(/[?#]/)[0];
    if (prog === "claude" || prog === "claude-code") return "claude";
    if (prog.startsWith("codex")) return "codex";
    if (prog === "gemini" || prog === "gemini-cli") return "gemini";
    if (prog.startsWith("aider")) return null; // aider isn't in the helper roster
    return null;
  }
  return null;
}

/**
 * True when a full command line invokes one of the known TUI agents.
 * Kept around for callers that just need a yes/no — internally derived
 * from {@link detectCliFromCommandLine}.
 */
function commandLineIsAgent(line: string): boolean {
  return detectCliFromCommandLine(line) !== null;
}

interface Props {
  /** Stable PTY session ID — must be unique per running PTY. */
  id: string;
  /** Command to spawn (e.g. "zsh", "claude", "codex"). */
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * When false, skip the helper-agent–driven activity-summary polling.
   * Surfaced via `settings.autoSummarize` so users with many parallel
   * agents can opt out of the per-PTY 4s subprocess cadence.
   */
  autoSummarize?: boolean;
  /**
   * Active project id. Forwarded to term_start so the PTY's env has
   * `RLI_PROJECT_ID` set — that's how the `rli-memory` CLI (and any
   * agent inside the PTY) knows which project to scope its memory
   * operations to. Optional only because legacy callers may not pass
   * it; null/undefined means no auto-scoping (memory writes are
   * unscoped, recall searches all projects).
   */
  projectId?: string;
  /** Active session id, mirrors `RLI_SESSION_ID` in PTY env. */
  sessionId?: string;
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
   *
   * `cli` is the detected agent CLI (claude / codex / gemini), or
   * null when no agent is running or the command line wasn't a known
   * agent. Used by the helper-agent layer to route summaries / commit
   * messages / PR drafts to the same CLI the user is actively driving.
   */
  onAgentRunningChange?: (running: boolean, cli: DetectedAgentCli) => void;
  /**
   * Fires whenever the live activity summary changes — i.e. what the
   * terminal is currently doing in one line. Empty string means idle.
   * Parent wires this into `session.subtitle` so the pane header (and
   * the status bar) reflect the running command in real time.
   */
  onActivitySummaryChange?: (summary: string) => void;
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
  autoSummarize = true,
  projectId,
  sessionId,
  onClaudeDetected,
  onAgentRunningChange,
  onActivitySummaryChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<PromptInputHandle>(null);
  const passthroughRef = useRef<PtyPassthroughHandle>(null);
  // Generation counter — bumped when the user clicks "restart" on the
  // session-ended banner. Suffixed onto the session id so the underlying
  // useTerminalSession effect tears down the dead PTY and spawns a fresh
  // one. Incrementing alone wouldn't be enough — useTerminalSession
  // keys its lifecycle on `opts.id`, so the id has to actually change.
  // The separator MUST stay inside Tauri's allowed event-name alphabet
  // (alphanumeric, `-`, `/`, `:`, `_`) — the hook builds event names like
  // `term://${id}/frame`. `-r<n>` works and reads cleanly in logs.
  const [generation, setGeneration] = useState(0);
  const ptyId = generation === 0 ? id : `${id}-r${generation}`;
  // In-memory ring buffer of past commands (newest at index 0).
  // Hydrated from module-scoped memory so it survives session/project
  // switches; module memory is keyed by terminal id, not component
  // instance.
  const [history, setHistory] = useState<string[]>(() => getHistory(id));
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
  const onActivitySummaryChangeRef = useRef(onActivitySummaryChange);
  useEffect(() => {
    onActivitySummaryChangeRef.current = onActivitySummaryChange;
  }, [onActivitySummaryChange]);
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

  // What the user typed to start the currently-running command.
  // Populates the synthetic header on the in-progress LiveBlock; used
  // to trim zsh's command-echo line out of the live grid body so the
  // command doesn't appear twice (header + first body row). Cleared
  // when the OSC 133 D marker fires.
  const [activeCommand, setActiveCommand] = useState<string>(
    directAgent ? command : "",
  );

  // Tell the parent (which dispatches into session state) every time
  // the foreground-agent flag flips. Done in an effect rather than
  // inside setForegroundIsAgent calls so we don't have to remember
  // to forward at every callsite. Includes the detected CLI so the
  // helper-agent layer can route to the same binary the user is
  // actively using.
  const lastReportedAgentRef = useRef(false);
  useEffect(() => {
    if (foregroundIsAgent !== lastReportedAgentRef.current) {
      lastReportedAgentRef.current = foregroundIsAgent;
      const cli: DetectedAgentCli = foregroundIsAgent
        ? detectCliFromCommandLine(activeCommand || command)
        : null;
      onAgentRunningChangeRef.current?.(foregroundIsAgent, cli);
    }
  }, [foregroundIsAgent, activeCommand, command]);

  // While a Claude-Code session is foregrounded, the launch command
  // ("claude") tells you nothing about what's actually happening. Ask
  // the helper-agent layer to summarize the last 3 turns of the
  // transcript — that lands a phrase like "wiring up the OSC 133
  // segmenter" instead. The Rust side caches the result keyed by the
  // turn uuids, so polling here is cheap unless a new exchange landed.
  //
  // Codex / Gemini have their own transcript layouts; for now we only
  // run this against Claude transcripts (the only one the helper
  // currently knows how to parse). Other CLIs fall back to the launch
  // command via the activeCommand path below.
  const [claudeSummary, setClaudeSummary] = useState<string | null>(null);
  useEffect(() => {
    if (!autoSummarize) {
      setClaudeSummary(null);
      return;
    }
    if (!foregroundIsAgent) {
      setClaudeSummary(null);
      return;
    }
    if (!cwd) return;
    const isClaudeLine = commandLineIsAgent(activeCommand || command)
      && detectCliFromCommandLine(activeCommand || command) === "claude";
    if (!isClaudeLine) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const summary = await invoke<string | null>("claude_activity_summary", {
          projectCwd: cwd,
          cli: "claude",
        });
        if (!cancelled) setClaudeSummary(summary);
      } catch {
        // Transient failures keep the last value — better than blanking.
      }
    };
    void tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [foregroundIsAgent, cwd, activeCommand, command]);

  // Forward the live activity summary up to the pane chrome, where it
  // surfaces as the subtitle next to the pane header. Trimmed and
  // collapsed-whitespace so multi-line composed commands read on one
  // line in a 28px header strip. Prefer the agent's AI-summarized
  // activity when available — it carries more meaning than the launch
  // command.
  //
  // CRITICAL: only dispatch when we actually have a summary. Firing
  // with `""` on idle mount erases whatever default the session had
  // ("ready") and leaves the header chip blank — that was the bug
  // that made it look like summaries weren't working at all. Letting
  // the prior value persist is the right default.
  useEffect(() => {
    const source = claudeSummary ?? activeCommand;
    const summary = source.replace(/\s+/g, " ").trim();
    if (!summary) return;
    onActivitySummaryChangeRef.current?.(summary);
  }, [activeCommand, claudeSummary]);

  const {
    blocks,
    liveFrame,
    altScreen,
    exited,
    cwd: liveCwd,
    bellTick,
    sendLine,
    sendBytes,
    resize,
  } = useTerminalSession({
    id: ptyId,
    command,
    args,
    cwd,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
    projectId,
    sessionId,
  });

  // PTY died (process crashed, backend restarted on a Rust hot-reload,
  // user `exit`-ed the shell, etc.). Drop out of agent mode so the
  // user isn't staring at a blank pane that used to be claude. The
  // UI below renders an "[ session ended — press Enter to restart ]"
  // affordance so they can re-spawn the shell without nuking the pane.
  useEffect(() => {
    if (!exited) return;
    if (foregroundIsAgent) setForegroundIsAgent(false);
    sniffBufferRef.current = "";
  }, [exited, foregroundIsAgent]);

  // `altScreen` covers vim/htop; `foregroundIsAgent` covers
  // claude/codex/etc. that render in the normal screen. Both hide
  // PromptInput + status bar so the agent's own UI owns the surface.
  // After the PTY exits, downshift back to shell-mode chrome regardless
  // of what the last frame's flags were — those readings are stale.
  const agentMode = !exited && (altScreen || foregroundIsAgent);

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
  //
  // The PTY's row count is what claude / codex / shell commands paint
  // into. We size it to the *visible* scroll viewport (container
  // height minus input chrome) so the in-progress LiveBlock fits
  // without overflowing the pane when scrolled to the bottom. The
  // LiveBlock's own header (~50px for cwd row + command name +
  // border) is reserved on top of that — without it, claude's last
  // row gets clipped behind the input zone.
  //
  // Agent mode (claude / codex / aider) gets an oversized PTY: the
  // visible viewport plus AGENT_ROW_HEADROOM. Without the headroom,
  // a multi-line paste that exceeds the visible row count overflows
  // claude's own input box, claude scrolls within itself, and the
  // top of the prompt slides into alacritty's scrollback (which we
  // don't render). With it, claude's input has enough rows to paint
  // the full prompt; trimEchoAndBlanks strips the leading blank
  // rows so the LiveBlock body sizes naturally to actual content;
  // and the outer column-reverse scroll lets the user reach the top
  // of the prompt by scrolling up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      const inputChrome = agentMode ? 8 : 80;
      const liveBlockChrome = 50;
      const reserved = inputChrome + liveBlockChrome;
      const usableHeight = Math.max(120, rect.height - reserved);
      const cellHeight = 13 * 1.35;
      // JetBrains Mono at 13px advances ~7.8px per glyph. Be slightly
      // conservative (0.62) so we ask the PTY for fewer columns than the
      // container can technically fit — better to leave a 1–2px gutter
      // on the right than to have claude paint a column that gets
      // clipped, which reads as "broken / cut off".
      const cellWidth = 13 * 0.62;
      const visibleRows = Math.max(8, Math.floor(usableHeight / cellHeight));
      const AGENT_ROW_HEADROOM = 80;
      const rows = foregroundIsAgent
        ? visibleRows + AGENT_ROW_HEADROOM
        : visibleRows;
      const cols = Math.max(20, Math.floor((rect.width - 24) / cellWidth));
      void resize(rows, cols).catch(() => {});
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize, agentMode, foregroundIsAgent]);

  // Sniff the live frame for the Claude banner so the 5h usage bar
  // attaches automatically AND we know to hide PromptInput in favor
  // of the agent's own input. Used only as a fallback — the
  // activeCommand-based foregrounding effect below covers the common
  // case (user typed "claude" / "codex" / "aider" at the shell).
  // Sniffing remains useful for wrappers, aliases, and direct-launch
  // panes whose initial frames pre-date this state being wired up.
  //
  // CRITICAL: only sniff while a command is actively running. After
  // Ctrl+C kills an agent the alacritty grid still holds the agent's
  // TUI bytes — without this gate, the very next frame after the
  // command_running=false transition would re-detect claude from
  // those leftover bytes and flip foregroundIsAgent back to true,
  // pinning PromptInput off-screen forever.
  //
  // Scans the full grid (claude's banner paints near the top of the
  // initial draw, so a tail-only scan misses it). Bails on the first
  // marker hit — the inner loop appends span text and short-circuits
  // as soon as detectClaude succeeds.
  useEffect(() => {
    if (foregroundIsAgent) return;
    if (!liveFrame) return;
    if (!liveFrame.command_running) return;
    let text = "";
    for (const dr of liveFrame.dirty) {
      const spans = dr.spans;
      for (let j = 0; j < spans.length; j++) text += spans[j].text;
      text += "\n";
    }
    if (text.length === 0) return;
    sniffBufferRef.current =
      sniffBufferRef.current.length + text.length > 16_384
        ? (sniffBufferRef.current + text).slice(-16_384)
        : sniffBufferRef.current + text;
    if (detectClaude(sniffBufferRef.current)) {
      setForegroundIsAgent(true);
      if (!claudeDetectedLocal) {
        setClaudeDetectedLocal(true);
        onClaudeDetectedRef.current?.(Date.now());
      }
      sniffBufferRef.current = "";
    }
  }, [liveFrame, foregroundIsAgent, claudeDetectedLocal]);

  // Foreground the agent the moment the user runs one from the shell.
  // The Claude-only banner sniff above is a slow path that doesn't
  // know about codex/aider; this catches every known agent on its
  // command line as soon as command_running flips to true. Skipped
  // for direct-launch panes (already foregrounded at mount).
  useEffect(() => {
    if (directAgent) return;
    if (foregroundIsAgent) return;
    if (!liveFrame?.command_running) return;
    if (!commandLineIsAgent(activeCommand)) return;
    setForegroundIsAgent(true);
  }, [
    directAgent,
    foregroundIsAgent,
    liveFrame?.command_running,
    activeCommand,
  ]);


  const onSubmit = useCallback(
    (text: string) => {
      setActiveCommand(text);
      void sendLine(text);
      if (text.trim().length > 0) {
        setHistory((prev) => {
          const next = [text, ...prev].slice(0, HISTORY_LIMIT);
          memSetHistory(id, next);
          return next;
        });
      }
    },
    [sendLine, id],
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

  // Once an agent foregrounds, we DO NOT release agent mode on a
  // single-frame `command_running=false` reading. OSC 133 D and C
  // markers can fire transiently during a TUI's lifetime (claude
  // redraws, scroll regions, etc.), and an immediate flip-back would
  // ping-pong against the banner-detect effect above — toggling the
  // PromptInput in/out, shifting the pane layout, and causing a
  // visible jitter that's hard to describe but very loud to look at.
  //
  // Instead: schedule the flip-back behind a debounce. If
  // `command_running` flips back to true before the timer fires (the
  // common case during a live agent session), we cancel and stay in
  // agent mode. Only a *sustained* idle period — long enough that the
  // agent has truly exited and dumped us back to the parent shell —
  // releases the takeover.
  const EXIT_DEBOUNCE_MS = 1500;
  const exitDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (directAgent) return;
    if (!liveFrame) return;
    if (!foregroundIsAgent) {
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
        exitDebounceRef.current = null;
      }
      return;
    }
    if (liveFrame.command_running) {
      // Agent is alive — cancel any pending flip-back.
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
        exitDebounceRef.current = null;
      }
      return;
    }
    // command_running is false AND we're in agent mode. Arm the timer
    // unless one is already counting down.
    if (exitDebounceRef.current === null) {
      exitDebounceRef.current = window.setTimeout(() => {
        exitDebounceRef.current = null;
        setForegroundIsAgent(false);
        sniffBufferRef.current = "";
        setTimeout(() => promptRef.current?.focus(), 0);
      }, EXIT_DEBOUNCE_MS);
    }
  }, [liveFrame?.command_running, foregroundIsAgent, directAgent]);

  // Tear down any pending exit-debounce when the component unmounts —
  // a fired timeout calling setState on a dead component would no-op
  // but it's still cleaner to cancel it.
  useEffect(() => {
    return () => {
      if (exitDebounceRef.current !== null) {
        window.clearTimeout(exitDebounceRef.current);
      }
    };
  }, []);

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
      {exited && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            backgroundColor: "var(--surface-error-soft)",
            color: "var(--state-error-bright)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            borderBottom: "var(--border-1)",
          }}
        >
          <span>session ended</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setGeneration((g) => g + 1)}
            style={{
              height: 22,
              padding: "0 var(--space-3)",
              backgroundColor: "var(--surface-2)",
              color: "var(--text-primary)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              cursor: "default",
            }}
          >
            restart
          </button>
        </div>
      )}

      {!exited && altScreen &&
        (isCanvasRendererEnabled() ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <CanvasGrid frame={liveFrame} onSendBytes={sendBytes} />
          </div>
        ) : (
          <FullGrid frame={liveFrame} onSendBytes={sendBytes} />
        ))}

      {/* One scroll container for everything that isn't alt-screen.
          Closed-block history (BlockList) above, in-progress LiveBlock
          pinned at the bottom (column-reverse). Same shape whether
          the running command is a shell command or a TUI agent —
          there is no separate "agent view." Agents render inline in
          the conversation as a `preserveGrid` LiveBlock so claude's
          UI doesn't wrap and the user keeps one continuous scroll
          over their whole session. */}
      {!altScreen && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column-reverse",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {liveFrame?.command_running && !exited && (
            <LiveBlock
              command={activeCommand}
              frame={liveFrame}
              cwd={effectiveCwd}
              preserveGrid={foregroundIsAgent}
            />
          )}
          <BlockList blocks={blocks} />
        </div>
      )}

      {!agentMode && effectiveCwd && (
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
          appCursor={liveFrame?.app_cursor ?? false}
          bracketedPaste={liveFrame?.bracketed_paste ?? false}
        />
      )}
    </div>
  );
}
