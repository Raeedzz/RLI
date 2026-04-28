/**
 * Wire format mirroring Rust's `term.rs` serde shapes. Keep in sync.
 */

export interface Span {
  text: string;
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikeout: boolean;
}

export interface DirtyRow {
  row: number;
  spans: Span[];
}

export interface RenderFrame {
  cols: number;
  rows: number;
  cursor_row: number;
  cursor_col: number;
  alt_screen: boolean;
  /**
   * True iff the segmenter is between OSC 133 C and D. The block-mode
   * BlockList only paints the live grid while a command is producing
   * output — between commands the empty zsh prompt rows would otherwise
   * ghost above the input box.
   */
  command_running: boolean;
  /**
   * DECCKM (application cursor mode). When true, the running program
   * has issued `ESC[?1h` — arrows must be sent as `ESC O A/B/C/D` not
   * `ESC [ A/B/C/D`. Claude / vim insert / readline TUIs all flip this.
   * Without honoring it, the agent never sees the user's arrow keys.
   */
  app_cursor: boolean;
  dirty: DirtyRow[];
}

export interface ClosedBlock {
  input: string;
  /**
   * Full byte transcript from OSC 133 A → D. Includes the user's
   * PROMPT (with ANSI styling), the echoed command, and the command's
   * output. Frontend parses SGR to render styled spans inside Block.
   */
  transcript: string;
  exit_code: number | null;
  /** cwd at OSC 133 C — where the command actually ran. */
  cwd: string | null;
  /** Wall-clock duration in ms from OSC 133 C → D. */
  durationMs: number | null;
}

export interface Block {
  /** Stable id we generate on receipt for React keys. */
  id: string;
  input: string;
  transcript: string;
  exit_code: number | null;
  cwd: string | null;
  durationMs: number | null;
}
