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
}

export interface Block {
  /** Stable id we generate on receipt for React keys. */
  id: string;
  input: string;
  transcript: string;
  exit_code: number | null;
}
