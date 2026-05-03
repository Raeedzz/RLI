import {
  useEffect,
  useRef,
  type KeyboardEvent,
} from "react";
import { CellRow } from "./CellRow";
import { isGlobalChord, keyToBytes } from "./keyEncoding";
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
    if (isGlobalChord(e)) return;
    const seq = keyToBytes(e, frame?.app_cursor ?? false);
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

