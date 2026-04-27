import {
  useEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import { CellRow } from "./CellRow";
import type { RenderFrame } from "./types";

interface Props {
  frame: RenderFrame | null;
  /** Forward raw keystrokes to the PTY (alt-screen apps need everything). */
  onSendBytes: (bytes: Uint8Array) => void;
}

const encoder = new TextEncoder();

/**
 * Full-screen renderer used while the Term is in alt-screen mode (vim,
 * htop, claude TUI). Hides the BlockList + PromptInput; renders all
 * grid rows and forwards every keystroke straight to the PTY via a
 * hidden auto-focused textarea.
 *
 * Special-key encoding (arrows, function keys, etc.) follows the
 * standard xterm sequences — tested against `vim` insert-mode + `htop`.
 */
export function FullGrid({ frame, onSendBytes }: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus the input when alt-screen mounts so the first keystroke
  // routes to vim/htop/claude without an extra click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't intercept global app chords.
    if (
      (e.metaKey || e.ctrlKey) &&
      ["k", "b", "n", "w", "o"].includes(e.key.toLowerCase()) &&
      !e.altKey
    ) {
      return;
    }
    const seq = keyToBytes(e);
    if (seq) {
      e.preventDefault();
      onSendBytes(seq);
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length > 0) {
      onSendBytes(encoder.encode(value));
      e.target.value = "";
    }
  };

  return (
    <div
      onMouseDown={() => inputRef.current?.focus()}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        backgroundColor: "var(--surface-0)",
        overflow: "hidden",
        cursor: "text",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: "var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.35,
          color: "var(--text-primary)",
        }}
      >
        {frame?.dirty.map((dr) => (
          <CellRow key={dr.row} spans={dr.spans} />
        ))}
      </div>
      {/* Hidden textarea catches keystrokes. Off-screen via opacity 0
          so OS IME composition still works. */}
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        onChange={onInput}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
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
    </div>
  );
}

/** Map a KeyboardEvent into the byte sequence the PTY expects. */
function keyToBytes(e: KeyboardEvent<HTMLTextAreaElement>): Uint8Array | null {
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  // Special keys
  switch (e.key) {
    case "Enter":
      return encoder.encode("\r");
    case "Backspace":
      return new Uint8Array([0x7f]);
    case "Tab":
      return encoder.encode("\t");
    case "Escape":
      return new Uint8Array([0x1b]);
    case "ArrowUp":
      return encoder.encode("\x1b[A");
    case "ArrowDown":
      return encoder.encode("\x1b[B");
    case "ArrowRight":
      return encoder.encode("\x1b[C");
    case "ArrowLeft":
      return encoder.encode("\x1b[D");
    case "Home":
      return encoder.encode("\x1b[H");
    case "End":
      return encoder.encode("\x1b[F");
    case "PageUp":
      return encoder.encode("\x1b[5~");
    case "PageDown":
      return encoder.encode("\x1b[6~");
    case "Delete":
      return encoder.encode("\x1b[3~");
  }
  // Ctrl-letter (e.g. ⌃C → 0x03, ⌃D → 0x04, ⌃Z → 0x1A)
  if (ctrl && !alt && e.key.length === 1) {
    const c = e.key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) {
      return new Uint8Array([c - 96]);
    }
  }
  // Regular printable chars are caught by the textarea's onChange handler
  // (so OS IME composition keeps working). We let those bubble.
  return null;
}
