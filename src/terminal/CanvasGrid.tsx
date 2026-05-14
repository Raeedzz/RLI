import {
  useEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createGridRenderer, type GridRenderer } from "./gpu/GridRenderer";
import { isGlobalChord, keyToBytes } from "./keyEncoding";
import type { DirtyRow, RenderFrame } from "./types";

interface Props {
  /**
   * Source frame. Provides cursor + cols + seq even when `rows` is
   * a windowed subset.
   */
  frame: RenderFrame | null;
  /**
   * When set, render this row sequence instead of `frame.dirty`.
   * Used by inline LiveBlock to render the trimmed visibleRows.
   * Cursor is hidden in this mode unless explicitly passed.
   */
  rows?: DirtyRow[];
  /**
   * Layout mode:
   *   - "fill": canvas fills its parent vertically (alt-screen).
   *   - "auto": canvas height = (rows.length × cellHeightCss);
   *     used for inline LiveBlock so the canvas sits in the
   *     conversation scroll like a regular block.
   */
  mode?: "fill" | "auto";
  /** PTY input forwarding. Optional — when undefined, no textarea
   *  overlay is mounted (read-only display). */
  onSendBytes?: (bytes: Uint8Array) => void;
  /** Optional override for the monospace font. */
  font?: string;
  /** Font size in CSS pixels (kept in sync with terminal cell metrics). */
  fontSizeCss?: number;
  lineHeight?: number;
}

/**
 * WebGPU canvas grid renderer (Phase 3).
 *
 * Two layout modes:
 *   - "fill" (default) — canvas fills its parent height; used for
 *     alt-screen apps (vim, htop, alt-screen claude).
 *   - "auto" — canvas height = rows.length × cellHeightCss; used by
 *     inline LiveBlock so canvas blocks sit in the column-reverse
 *     conversation scroll alongside DOM-rendered closed blocks.
 *
 * Input flows through a hidden textarea overlaid on the canvas
 * (same pattern as FullGrid + PtyPassthrough). All three paths
 * encode keys via the shared keyEncoding module.
 */
export function CanvasGrid({
  frame,
  rows,
  mode = "fill",
  onSendBytes,
  font,
  fontSizeCss = 13,
  lineHeight = 1.35,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);
  const frameRef = useRef<RenderFrame | null>(frame);
  const rowsRef = useRef<DirtyRow[] | undefined>(rows);
  frameRef.current = frame;
  rowsRef.current = rows;

  // Auto-height: compute pixel height from row count + line metric.
  // Uses the same constants as the renderer's atlas so the canvas
  // surface matches what's rendered exactly.
  const cellHeightCss = fontSizeCss * lineHeight;
  const autoHeightPx = useMemo(() => {
    if (mode !== "auto") return undefined;
    const rowCount = rows ? rows.length : (frame?.dirty.length ?? 0);
    return Math.max(cellHeightCss, rowCount * cellHeightCss);
  }, [mode, rows, frame?.dirty.length, cellHeightCss]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    let cancelled = false;
    const fontFamily =
      font ??
      "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace";

    void createGridRenderer(canvas, fontFamily, fontSizeCss, lineHeight)
      .then((renderer) => {
        if (cancelled) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        const rect = wrapper.getBoundingClientRect();
        renderer.resize(
          rect.width,
          rect.height,
          window.devicePixelRatio || 1,
        );
        renderRequest(renderer);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[CanvasGrid] WebGPU init failed:", err);
      });

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint on frame / rows / cursor change. The renderer dedupes
  // by seq so a re-render with the same frame is a cheap no-op.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    renderRequest(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, rows]);

  // Resize the canvas when the container changes.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const rect = entries[0].contentRect;
      renderer.resize(
        rect.width,
        rect.height,
        window.devicePixelRatio || 1,
      );
      renderRequest(renderer);
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Drive a render based on whichever input mode the caller chose.
  // Always reads via the refs so it stays valid through async resize
  // and frame events.
  function renderRequest(r: GridRenderer): void {
    const f = frameRef.current;
    const explicitRows = rowsRef.current;
    if (explicitRows) {
      // Inline mode — caller-provided row window. Cursor is hidden
      // because cursor coords are in original-grid space; mapping
      // them onto the trimmed window is a Phase 4 concern.
      r.render({
        rows: explicitRows,
        cols: f?.cols ?? 80,
        seq: f?.seq ?? 0,
        cursor: null,
      });
    } else {
      r.renderFrame(f);
    }
  }

  // Input handling. Mirrors FullGrid / PtyPassthrough so all three
  // paths agree on encoding. Read-only when onSendBytes is omitted.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!onSendBytes) return;
    if (isGlobalChord(e)) return;
    const seq = keyToBytes(e, frame?.app_cursor ?? false);
    if (seq) {
      e.preventDefault();
      onSendBytes(seq);
    }
  };

  const pendingPasteRef = useRef<string | null>(null);
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSendBytes) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    pendingPasteRef.current = text;
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!onSendBytes) return;
    const value = e.target.value;
    if (value.length === 0) return;
    const pasted = pendingPasteRef.current;
    pendingPasteRef.current = null;
    const enc = new TextEncoder();
    if (frame?.bracketed_paste && pasted !== null && value === pasted) {
      const PASTE_START = enc.encode("\x1b[200~");
      const PASTE_END = enc.encode("\x1b[201~");
      const payload = enc.encode(value);
      const out = new Uint8Array(
        PASTE_START.length + payload.length + PASTE_END.length,
      );
      out.set(PASTE_START, 0);
      out.set(payload, PASTE_START.length);
      out.set(PASTE_END, PASTE_START.length + payload.length);
      onSendBytes(out);
    } else {
      onSendBytes(enc.encode(value));
    }
    e.target.value = "";
  };

  return (
    <div
      ref={wrapperRef}
      onMouseDown={() => inputRef.current?.focus()}
      style={{
        width: "100%",
        height: mode === "auto" ? `${autoHeightPx}px` : "100%",
        position: "relative",
        backgroundColor: "var(--surface-0)",
        cursor: onSendBytes ? "text" : "default",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      {onSendBytes && (
        <textarea
          ref={inputRef}
          onKeyDown={onKeyDown}
          onChange={onInput}
          onPaste={onPaste}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Terminal input passthrough"
          style={{
            position: "absolute",
            left: -10000,
            top: -10000,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

/**
 * Returns true if the canvas renderer is enabled via URL flag. Set
 * `?renderer=canvas` in the dev URL or `localStorage.rli.renderer =
 * "canvas"` to toggle on without restart.
 */
export function isCanvasRendererEnabled(): boolean {
  try {
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("renderer") === "canvas"
    ) {
      return true;
    }
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("gli.renderer") === "canvas"
    ) {
      return true;
    }
  } catch {
    // localStorage / URL inaccessible — bail to DOM renderer.
  }
  return false;
}
