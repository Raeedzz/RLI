import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { xtermOptions, xtermTheme } from "@/design/xterm-theme";
import { detectClaude } from "@/lib/claudeUsage";
import { ClaudeUsageBar } from "./ClaudeUsageBar";
import { TerminalStatusBar } from "./TerminalStatusBar";

interface Props {
  /** Stable PTY session ID — must be unique per running PTY. */
  id: string;
  /** Command to spawn (e.g. "claude", "zsh", "codex"). */
  command: string;
  /** Optional args. */
  args?: string[];
  /** Working directory. Defaults to home if omitted. */
  cwd?: string;
  /** Called when the spawned process exits. */
  onExit?: () => void;
}

/**
 * xterm.js terminal pane bound to a Rust-side PTY.
 *
 * Mounts xterm with the WebGL addon (canvas fallback if WebGL fails),
 * spawns a PTY via the `pty_start` Tauri command, streams bytes into
 * xterm via `pty://<id>/data` events, forwards user keystrokes back
 * via `pty_write`, and resizes the PTY when the container resizes.
 *
 * On unmount: kills the spawned process and disposes xterm cleanly.
 */
export function Terminal({ id, command, args = [], cwd, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialStart = command.toLowerCase() === "claude" ? Date.now() : null;
  const [claudeStartedAt, setClaudeStartedAt] = useState<number | null>(
    initialStart,
  );
  // Source of truth for the listener closure (state updates wouldn't be
  // visible inside the long-lived listener otherwise — we'd keep re-firing).
  const claudeStartRef = useRef<number | null>(initialStart);
  // Hold the most recent ~16KB of decoded PTY output for sniffing —
  // the Claude banner appears within the first chunk so this stays small.
  const sniffBufferRef = useRef<string>("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      ...xtermOptions,
      theme: xtermTheme,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl?.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL not available; xterm falls back to its DOM renderer.
    }

    term.open(container);

    // Initial fit may run before fonts are ready — schedule one after the
    // next animation frame so character metrics are correct.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore — happens if container is not visible yet */
      }
    });

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let cancelled = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const start = async () => {
      try {
        unlistenData = await listen<number[]>(
          `pty://${id}/data`,
          (event) => {
            if (cancelled) return;
            const bytes = new Uint8Array(event.payload);
            term.write(bytes);

            // Sniff for the Claude banner. Once detected we stop sniffing
            // — the start time anchors the 5h window from then on.
            if (claudeStartRef.current === null) {
              const text = decoder.decode(bytes, { stream: true });
              sniffBufferRef.current = (sniffBufferRef.current + text).slice(
                -16_384,
              );
              if (detectClaude(sniffBufferRef.current)) {
                const t = Date.now();
                claudeStartRef.current = t;
                setClaudeStartedAt(t);
                sniffBufferRef.current = "";
              }
            }
          },
        );
        unlistenExit = await listen(`pty://${id}/exit`, () => {
          if (cancelled) return;
          term.writeln("\r\n\x1b[2m[process exited]\x1b[0m");
          onExit?.();
        });

        await invoke("pty_start", {
          args: {
            id,
            command,
            args,
            cwd,
            rows: term.rows,
            cols: term.cols,
          },
        });

        term.onData((data) => {
          if (cancelled) return;
          invoke("pty_write", {
            id,
            data: Array.from(encoder.encode(data)),
          }).catch(() => {
            /* swallow — process may have exited */
          });
        });
      } catch (err) {
        term.writeln(
          `\r\n\x1b[31merror starting pty: ${String(err)}\x1b[0m`,
        );
      }
    };
    void start();

    // Resize observer — fits xterm and tells the backend the new size.
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        invoke("pty_resize", {
          id,
          rows: term.rows,
          cols: term.cols,
        }).catch(() => {
          /* swallow */
        });
      } catch {
        /* ignore */
      }
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
      resizeObserver.disconnect();
      invoke("pty_close", { id }).catch(() => {
        /* swallow */
      });
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, command, JSON.stringify(args), cwd]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div
        ref={containerRef}
        className="terminal-content"
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          // No inset — xterm fills its container edge-to-edge. The terminal
          // grid's own per-cell padding gives the text the breathing room
          // it needs. Inner padding here just clipped cells weirdly.
          padding: 0,
        }}
      />
      {cwd && <TerminalStatusBar cwd={cwd} command={command} />}
      {claudeStartedAt !== null && (
        <ClaudeUsageBar startedAt={claudeStartedAt} />
      )}
    </div>
  );
}
