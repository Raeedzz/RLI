import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
} from "react";

export interface PtyPassthroughHandle {
  focus: () => void;
}

interface Props {
  /** Forward raw keystrokes to the PTY. */
  onSendBytes: (bytes: Uint8Array) => void;
}

const encoder = new TextEncoder();

/**
 * Invisible focus-trap that forwards every keystroke straight to the
 * PTY. Mounted in place of `PromptInput` when the foreground process
 * is an interactive TUI agent (claude, codex, etc.) — the agent
 * renders its own input prompt inside the live frame, so RLI's
 * textarea would only duplicate it.
 *
 * Same wire encoding as `FullGrid`'s key handler: special keys map
 * to the standard xterm escape sequences, ⌃-letter maps to its
 * control byte, plain printable chars route through `onChange` so
 * OS IME composition still works. Off-screen via fixed positioning
 * so the textarea is invisible but focusable.
 */
export const PtyPassthrough = forwardRef<PtyPassthroughHandle, Props>(
  function PtyPassthrough({ onSendBytes }, ref) {
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

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
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        onChange={onInput}
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
    );
  },
);

/** Map a KeyboardEvent into the byte sequence the PTY expects. */
function keyToBytes(e: KeyboardEvent<HTMLTextAreaElement>): Uint8Array | null {
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
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
  if (ctrl && !alt && e.key.length === 1) {
    const c = e.key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) {
      return new Uint8Array([c - 96]);
    }
  }
  // Printable chars handled in onInput (preserves IME composition).
  return null;
}
