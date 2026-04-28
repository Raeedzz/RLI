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
  /**
   * DECCKM (application cursor mode). When the running program has
   * issued `ESC[?1h` (claude, vim insert mode, readline TUIs all do
   * this), arrows must be sent as `ESC O A/B/C/D` instead of the
   * default `ESC [ A/B/C/D`. Without honoring this, the agent
   * never sees the user's arrow keys.
   */
  appCursor: boolean;
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
  function PtyPassthrough({ onSendBytes, appCursor }, ref) {
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
      const seq = keyToBytes(e, appCursor);
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

/** Map a KeyboardEvent into the byte sequence the PTY expects. The
 *  `appCursor` flag selects between cursor-mode and application-mode
 *  arrow encoding (DECCKM). */
function keyToBytes(
  e: KeyboardEvent<HTMLTextAreaElement>,
  appCursor: boolean,
): Uint8Array | null {
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  // Application cursor mode: arrows are SS3-prefixed, not CSI.
  // Home / End follow the same convention. Without this branch claude
  // (and vim insert, and any readline-based TUI) silently drops arrows.
  const csi = (c: string) => encoder.encode(`\x1b[${c}`);
  const ss3 = (c: string) => encoder.encode(`\x1bO${c}`);
  const arrow = (c: string) => (appCursor ? ss3(c) : csi(c));
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
      return arrow("A");
    case "ArrowDown":
      return arrow("B");
    case "ArrowRight":
      return arrow("C");
    case "ArrowLeft":
      return arrow("D");
    case "Home":
      return arrow("H");
    case "End":
      return arrow("F");
    case "PageUp":
      return csi("5~");
    case "PageDown":
      return csi("6~");
    case "Delete":
      return csi("3~");
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
