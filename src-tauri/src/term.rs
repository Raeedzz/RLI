//! Terminal emulator backed by `alacritty_terminal`.
//!
//! Replaces the previous xterm.js-driven `pty.rs`. The Rust side now owns
//! the full terminal grid: a VTE parser feeds PTY bytes into an Alacritty
//! `Term`, we walk the grid into compressed RGB-colored span runs, and
//! emit frame deltas + closed-block events to the frontend over Tauri
//! events. The frontend renders cells as DOM (one styled `<span>` per
//! run), giving us per-cell control for the Warp-style block UI.
//!
//! Key invariants:
//!   * One reader thread per session does PTY reads → VTE parse → frame
//!     diff. All Term mutation lives on that thread; command handlers
//!     only mutate via the shared `Mutex<Session>` (resize, write).
//!   * Frames are throttled to ~60 Hz — heavy output (`seq 1 100000`)
//!     coalesces instead of overwhelming the IPC channel.
//!   * `BlockSegmenter` scans the raw byte stream (parallel to VTE) for
//!     OSC 133 prompt markers; closed blocks emit their own event.
//!     Unmarked shells get an idle-quiescence fallback.
//!   * When the Term is in alt-screen mode (vim, htop, claude TUI), the
//!     segmenter pauses and the frontend swaps from BlockList to FullGrid.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event as AlacEvent, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config as TermConfig, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use alacritty_terminal::Term;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

const SCROLLBACK_LIMIT: usize = 10_000;
const FRAME_THROTTLE: Duration = Duration::from_millis(16); // ~60 Hz

/* ------------------------------------------------------------------
   State container — one entry per running PTY session.
   ------------------------------------------------------------------ */

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

struct Session {
    term: Term<EventProxy>,
    parser: Processor,
    pty_master: Box<dyn MasterPty + Send>,
    pty_writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cols: u16,
    rows: u16,
    /// Last full snapshot we sent to the frontend. We diff against this so
    /// only changed rows go over the wire.
    last_snapshot: Vec<RowSnapshot>,
    /// When we last flushed a frame — used for the 16 ms throttle.
    last_flush: Instant,
    /// Last `command_running` value we emitted. We send a frame every
    /// time this flips even when no rows are dirty — otherwise the
    /// frontend never sees the running→idle transition that follows a
    /// Ctrl+C kill (zsh's empty PROMPT doesn't repaint anything).
    last_command_running: bool,
    segmenter: BlockSegmenter,
    /// Monotonic frame counter. Increments on every emit (regardless
    /// of whether the frame had dirty rows). Frontend uses this to
    /// dedupe rAF flushes (skip if seq unchanged) and detect dropped
    /// frames for backpressure.
    next_frame_seq: u64,
}

/* ------------------------------------------------------------------
   EventListener — alacritty wakes us for bell, title changes, etc.
   We forward only what the frontend actually does something with.
   ------------------------------------------------------------------ */

// Locked to `Wry` (Tauri's desktop runtime). GLI is macOS-desktop-only,
// so we trade the generics for a much simpler `Session` type definition
// — `Session` doesn't have to thread `R` through every field.
#[derive(Clone)]
struct EventProxy(AppHandle<Wry>, String);

impl EventListener for EventProxy {
    fn send_event(&self, event: AlacEvent) {
        match event {
            AlacEvent::Bell => {
                let _ = self
                    .0
                    .emit(&format!("term://{}/bell", self.1), ());
            }
            AlacEvent::Title(title) => {
                let _ = self.0.emit(&format!("term://{}/title", self.1), title);
            }
            AlacEvent::ChildExit(code) => {
                let _ = self
                    .0
                    .emit(&format!("term://{}/exit", self.1), code);
            }
            // PtyWrite happens when the terminal needs to send bytes back
            // to the shell (e.g. cursor position queries). We need to
            // honor these for full TUI app compat.
            AlacEvent::PtyWrite(bytes) => {
                // We can't easily reach the writer from here (no &mut access).
                // Stuff is stashed on Session; callers that care about
                // round-tripping cursor queries would need to wire this
                // through. For v1 we ignore it — most apps don't depend
                // on it, and `claude` certainly doesn't.
                let _ = bytes;
            }
            _ => {}
        }
    }
}

/* ------------------------------------------------------------------
   Dimensions — alacritty's `Dimensions` trait, dirt simple.
   ------------------------------------------------------------------ */

#[derive(Copy, Clone)]
struct Dims {
    cols: usize,
    rows: usize,
}

impl Dimensions for Dims {
    fn total_lines(&self) -> usize {
        self.rows + SCROLLBACK_LIMIT
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/* ------------------------------------------------------------------
   Wire format — what we ship to the frontend.
   ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub text: String,
    pub fg: String,    // CSS color string (e.g. "#abc123" or "currentColor")
    pub bg: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub dim: bool,
    pub strikeout: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowSnapshot {
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderFrame {
    /// Monotonic frame sequence id. Frontend uses it to dedupe rAF
    /// flushes (skip if unchanged) and detect dropped frames in
    /// burst windows.
    pub seq: u64,
    /// Stable id of the block this frame belongs to (the in-progress
    /// block, between OSC 133 A and the next D). 0 means no block is
    /// active — happens before the first prompt and briefly between
    /// blocks. Renderers can identify which block a frame's content
    /// belongs to without reading the transcript.
    pub block_id: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: i32,
    pub cursor_col: u16,
    pub alt_screen: bool,
    /// True iff the segmenter is currently between OSC 133 C and D
    /// (i.e. a command is producing output). Frontend uses this to
    /// hide the live grid when no command is running so the empty
    /// rows of the shell prompt don't ghost above the input.
    pub command_running: bool,
    /// DECCKM (application cursor mode). True iff the running program
    /// has issued `ESC[?1h`. Many TUIs (claude, vim insert mode,
    /// readline-based tools) flip this — when set, arrow keys must be
    /// sent as `ESC O A/B/C/D` instead of `ESC [ A/B/C/D`. Frontend's
    /// keyToBytes branches on this. Without it, arrows in claude
    /// are silently dropped.
    pub app_cursor: bool,
    /// DECSET 2004 (bracketed paste). True iff the running program has
    /// issued `ESC[?2004h`. Claude, codex, and most readline-based
    /// TUIs flip this so they can distinguish a paste from typed
    /// input. When set, the frontend must wrap pasted bytes in
    /// `ESC[200~ ... ESC[201~` so the agent renders the whole paste
    /// atomically — without it, multi-line pastes trickle in line by
    /// line and the bottom of a big prompt appears to "load slowly."
    pub bracketed_paste: bool,
    /// Sparse: only rows that changed since the last frame. Frontend
    /// keeps the rest from its previous snapshot.
    pub dirty: Vec<DirtyRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirtyRow {
    pub row: u16,
    pub spans: Vec<Span>,
}

/* ------------------------------------------------------------------
   Block segmenter — OSC 133 + idle fallback.
   ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
enum SegState {
    /// Haven't seen the first prompt yet — anything before A is dropped.
    BeforePrompt,
    /// We're inside the prompt itself (between A and B). We don't capture this.
    InPromptDrawing,
    /// User is typing the next command (between B and C).
    AwaitingCommand,
    /// The command's output is streaming (between C and D / next A).
    InOutput,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosedBlock {
    /// Stable monotonic id minted at OSC 133 A. Renderers use this to
    /// identify a block across reflow / resize / scroll without having
    /// to compare transcript bytes. 0 means "id was never minted"
    /// (shouldn't happen in practice for closed blocks).
    pub block_id: u64,
    /// User's typed command. Populated by the frontend's pending-input
    /// queue (`useTerminalSession`) — Rust always emits this empty
    /// because we deliberately skip OSC 133 B.
    pub input: String,
    /// Full byte transcript for this block, from the OSC 133 A that
    /// opened it through the OSC 133 D that closed it. Includes the
    /// user's PROMPT bytes (with all their SGR styling), the echoed
    /// command, and the command's output. The frontend renders this
    /// with a small SGR parser so the block looks visually identical
    /// to what scrolled past in the live terminal.
    pub transcript: String,
    pub exit_code: Option<i32>,
    /// Working directory at the moment the command started running
    /// (OSC 133 C). Populated from the most recent OSC 7 the
    /// segmenter has seen. None if the shell never reported a cwd.
    pub cwd: Option<String>,
    /// Wall-clock duration from OSC 133 C → D in milliseconds. None
    /// if D was never observed (e.g. shell ate the marker or the
    /// command hard-killed before exiting).
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

struct BlockSegmenter {
    state: SegState,
    osc_buf: Vec<u8>,
    in_osc: bool,
    current_input: String,
    /// Raw bytes captured from OSC 133 A through D. See `ClosedBlock::transcript`.
    current_transcript: Vec<u8>,
    /// Latched on the OSC 133 C transition; the reader thread reads &
    /// clears it as a signal to wipe `last_snapshot`. Forces the next
    /// frame to re-emit every row so the new command starts on a
    /// fresh canvas (instead of diffing against the prior command's
    /// trailing output).
    command_just_started: bool,
    /// Latched on each OSC 7 (path-reporting) message. The reader
    /// thread drains this and emits a `term://<id>/cwd` Tauri event so
    /// the chrome's folder pill follows the live terminal cwd.
    pending_cwd: Option<String>,
    /// Most recent OSC 7 cwd. Snapshotted onto each ClosedBlock at
    /// OSC 133 C so each rendered block shows where it ran.
    current_cwd: Option<String>,
    /// Snapshotted at OSC 133 C and copied onto the ClosedBlock when
    /// it closes. Stays None until C fires.
    current_block_cwd: Option<String>,
    /// Wall-clock instant of the last OSC 133 C — used to compute
    /// `duration_ms` when the matching D arrives.
    current_block_start: Option<Instant>,
    /// Monotonic counter for block ids. Incremented at every OSC 133 A
    /// that mints a new block; the previous block's id is captured in
    /// `current_block_id` until the block closes.
    next_block_id: u64,
    /// Id of the block currently being constructed. 0 when no block
    /// is in progress (i.e. before the first prompt or between D and
    /// the next A).
    current_block_id: u64,
}

impl BlockSegmenter {
    fn new() -> Self {
        Self {
            state: SegState::BeforePrompt,
            osc_buf: Vec::with_capacity(64),
            in_osc: false,
            current_input: String::new(),
            current_transcript: Vec::with_capacity(4096),
            command_just_started: false,
            pending_cwd: None,
            current_cwd: None,
            current_block_cwd: None,
            current_block_start: None,
            next_block_id: 1,
            current_block_id: 0,
        }
    }

    fn current_block_id(&self) -> u64 {
        self.current_block_id
    }

    fn command_running(&self) -> bool {
        matches!(self.state, SegState::InOutput)
    }

    fn take_command_just_started(&mut self) -> bool {
        let v = self.command_just_started;
        self.command_just_started = false;
        v
    }

    fn take_pending_cwd(&mut self) -> Option<String> {
        self.pending_cwd.take()
    }

    /// Feed a chunk of PTY bytes. Returns Some(block) on close.
    fn feed(&mut self, bytes: &[u8]) -> Vec<ClosedBlock> {
        let mut blocks = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            if self.in_osc {
                // Terminate on BEL (\x07) or ST (\x1b\x5c).
                if b == 0x07 {
                    self.handle_osc(&mut blocks);
                    self.osc_buf.clear();
                    self.in_osc = false;
                } else if b == 0x1b
                    && i + 1 < bytes.len()
                    && bytes[i + 1] == 0x5c
                {
                    self.handle_osc(&mut blocks);
                    self.osc_buf.clear();
                    self.in_osc = false;
                    i += 1; // consume the trailing 0x5c too
                } else {
                    self.osc_buf.push(b);
                }
                i += 1;
                continue;
            }

            // Detect ESC ] which begins an OSC sequence.
            if b == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == 0x5d {
                self.in_osc = true;
                i += 2;
                continue;
            }

            // Inside an active block (between A and D), accumulate every
            // byte into the transcript. That includes the prompt's SGR
            // codes, the echoed user input, AND the command output, so
            // the frontend can render a faithful styled replay of the
            // block.
            match self.state {
                SegState::InPromptDrawing
                | SegState::AwaitingCommand
                | SegState::InOutput => {
                    self.current_transcript.push(b);
                }
                SegState::BeforePrompt => {}
            }
            // Keep current_input populated only if a shell *does* emit B
            // (we don't, but defensive). It's a fallback used when the
            // frontend's pending queue is empty.
            if matches!(self.state, SegState::AwaitingCommand)
                && b != b'\r'
                && b != b'\n'
            {
                self.current_input.push(b as char);
            }
            i += 1;
        }
        blocks
    }

    fn handle_osc(&mut self, blocks: &mut Vec<ClosedBlock>) {
        let buf = &self.osc_buf;
        // OSC 7 — cwd reporting. Format: `7;file://hostname/path`. We
        // strip the scheme + hostname and stash the path so the reader
        // thread can emit a Tauri event.
        if buf.starts_with(b"7;") {
            if let Ok(s) = std::str::from_utf8(&buf[2..]) {
                if let Some(path) = parse_file_url(s) {
                    self.pending_cwd = Some(path.clone());
                    self.current_cwd = Some(path);
                }
            }
            return;
        }
        // OSC 133 — block boundaries.
        if !buf.starts_with(b"133;") {
            return;
        }
        let kind = buf.get(4).copied();
        let rest = if buf.len() > 5 && buf[5] == b';' {
            std::str::from_utf8(&buf[6..]).unwrap_or("")
        } else {
            ""
        };
        match kind {
            Some(b'A') => {
                // Prompt start. If we were already in a block, the
                // previous one closes here (D may have been omitted by
                // some shells / non-zero-exit paths).
                if matches!(self.state, SegState::InOutput | SegState::AwaitingCommand) {
                    self.close(None, blocks);
                }
                self.state = SegState::InPromptDrawing;
                self.current_transcript.clear();
                // Mint a stable id for the new block. Renderers can
                // identify blocks across reflow/resize/scroll without
                // having to compare transcript bytes.
                self.current_block_id = self.next_block_id;
                self.next_block_id = self.next_block_id.saturating_add(1);
            }
            Some(b'B') => {
                self.state = SegState::AwaitingCommand;
                self.current_input.clear();
            }
            Some(b'C') => {
                self.state = SegState::InOutput;
                self.command_just_started = true;
                self.current_block_cwd = self.current_cwd.clone();
                self.current_block_start = Some(Instant::now());
            }
            Some(b'D') => {
                let exit = rest.parse::<i32>().ok();
                self.close(exit, blocks);
                self.state = SegState::BeforePrompt;
            }
            _ => {}
        }
    }

    fn close(&mut self, exit_code: Option<i32>, blocks: &mut Vec<ClosedBlock>) {
        if self.current_input.is_empty() && self.current_transcript.is_empty() {
            return;
        }
        let transcript = String::from_utf8_lossy(&self.current_transcript).into_owned();
        let duration_ms = self
            .current_block_start
            .take()
            .map(|start| start.elapsed().as_millis() as u64);
        let cwd = self.current_block_cwd.take();
        let block_id = self.current_block_id;
        self.current_block_id = 0;
        blocks.push(ClosedBlock {
            block_id,
            input: std::mem::take(&mut self.current_input),
            transcript,
            exit_code,
            cwd,
            duration_ms,
        });
        self.current_transcript.clear();
    }
}

/// `file://hostname/path` → `path`. Hostnames are accepted but
/// discarded; we don't render or compare them. URL escapes (`%20`)
/// are decoded in place so paths with spaces show correctly.
fn parse_file_url(s: &str) -> Option<String> {
    let after_scheme = s.strip_prefix("file://")?;
    let path_start = after_scheme.find('/')?;
    let raw = &after_scheme[path_start..];
    Some(percent_decode(raw))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h * 16 + l) as u8) as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/* ------------------------------------------------------------------
   Color → CSS conversion. Uses the same 16-color palette xterm-theme.ts
   shipped with, plus passes through 24-bit truecolor RGB.
   ------------------------------------------------------------------ */

fn color_to_css(c: Color, fallback: &str) -> String {
    match c {
        Color::Spec(Rgb { r, g, b }) => format!("#{:02x}{:02x}{:02x}", r, g, b),
        Color::Indexed(i) => indexed_color(i, fallback),
        Color::Named(named) => named_color(named, fallback),
    }
}

fn indexed_color(i: u8, _fallback: &str) -> String {
    if i < 16 {
        return ANSI_16[i as usize].into();
    }
    if (16..=231).contains(&i) {
        // 6×6×6 cube
        let n = i - 16;
        let r = (n / 36) % 6;
        let g = (n / 6) % 6;
        let b = n % 6;
        let conv = |c: u8| -> u8 {
            if c == 0 {
                0
            } else {
                55 + c * 40
            }
        };
        return format!(
            "#{:02x}{:02x}{:02x}",
            conv(r),
            conv(g),
            conv(b)
        );
    }
    // 232..=255 grayscale
    let level = 8 + (i - 232) * 10;
    format!("#{level:02x}{level:02x}{level:02x}")
}

fn named_color(c: NamedColor, fallback: &str) -> String {
    match c {
        NamedColor::Foreground => "var(--text-primary)".into(),
        NamedColor::Background => "var(--surface-0)".into(),
        NamedColor::Cursor => "var(--accent-bright)".into(),
        NamedColor::DimBlack => ANSI_16[0].into(),
        NamedColor::Black => ANSI_16[0].into(),
        NamedColor::BrightBlack => ANSI_16[8].into(),
        NamedColor::DimRed | NamedColor::Red => ANSI_16[1].into(),
        NamedColor::BrightRed => ANSI_16[9].into(),
        NamedColor::DimGreen | NamedColor::Green => ANSI_16[2].into(),
        NamedColor::BrightGreen => ANSI_16[10].into(),
        NamedColor::DimYellow | NamedColor::Yellow => ANSI_16[3].into(),
        NamedColor::BrightYellow => ANSI_16[11].into(),
        NamedColor::DimBlue | NamedColor::Blue => ANSI_16[4].into(),
        NamedColor::BrightBlue => ANSI_16[12].into(),
        NamedColor::DimMagenta | NamedColor::Magenta => ANSI_16[5].into(),
        NamedColor::BrightMagenta => ANSI_16[13].into(),
        NamedColor::DimCyan | NamedColor::Cyan => ANSI_16[6].into(),
        NamedColor::BrightCyan => ANSI_16[14].into(),
        NamedColor::DimWhite | NamedColor::White => ANSI_16[7].into(),
        NamedColor::BrightWhite => ANSI_16[15].into(),
        NamedColor::BrightForeground => "var(--text-primary)".into(),
        _ => fallback.into(),
    }
}

// 16 ANSI colors tuned to the workshop-pigment palette for visual
// consistency with the rest of the chrome. Same OKLCH values that lived
// in xterm-theme.ts before this migration.
const ANSI_16: [&str; 16] = [
    "#1c1a17", // black
    "#d97757", // red — workshop rust
    "#86a16f", // green — workshop moss
    "#d8b572", // yellow — workshop amber
    "#7fa1c0", // blue — accent steel
    "#a78fc4", // magenta — workshop iris
    "#7ca0a3", // cyan — workshop pine
    "#b9b4ad", // white
    "#403c37", // bright black
    "#e8896d", // bright red
    "#9ec189", // bright green
    "#e8c98c", // bright yellow
    "#9ab9d4", // bright blue
    "#bda9d6", // bright magenta
    "#92b8bb", // bright cyan
    "#dcd6cc", // bright white
];

/* ------------------------------------------------------------------
   Frame snapshot — walk the grid and compress styled runs.
   ------------------------------------------------------------------ */

fn snapshot_grid(term: &Term<EventProxy>) -> Vec<RowSnapshot> {
    let cols = term.columns();
    let rows = term.screen_lines();
    let mut out = Vec::with_capacity(rows);

    for row_idx in 0..rows {
        let mut spans: Vec<Span> = Vec::new();
        let mut current: Option<Span> = None;
        for col_idx in 0..cols {
            let point = Point::new(Line(row_idx as i32), Column(col_idx));
            let cell: &Cell = &term.grid()[point];
            // Skip the right half of wide chars — the left half already
            // emitted the full glyph, and rendering a "spacer" produces
            // double-printed CJK.
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }

            let span = cell_to_span(cell);
            match &mut current {
                Some(c) if c.fg == span.fg
                    && c.bg == span.bg
                    && c.bold == span.bold
                    && c.italic == span.italic
                    && c.underline == span.underline
                    && c.inverse == span.inverse
                    && c.dim == span.dim
                    && c.strikeout == span.strikeout =>
                {
                    c.text.push_str(&span.text);
                }
                Some(_) | None => {
                    if let Some(c) = current.take() {
                        spans.push(c);
                    }
                    current = Some(span);
                }
            }
        }
        if let Some(c) = current.take() {
            spans.push(c);
        }
        out.push(RowSnapshot { spans });
    }
    out
}

fn cell_to_span(cell: &Cell) -> Span {
    let mut text = String::new();
    text.push(cell.c);
    if let Some(zw) = cell.zerowidth() {
        for ch in zw {
            text.push(*ch);
        }
    }
    Span {
        text,
        fg: color_to_css(cell.fg, "var(--text-primary)"),
        bg: color_to_css(cell.bg, "var(--surface-0)"),
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        inverse: cell.flags.contains(Flags::INVERSE),
        dim: cell.flags.contains(Flags::DIM),
        strikeout: cell.flags.contains(Flags::STRIKEOUT),
    }
}

fn diff_rows(prev: &[RowSnapshot], next: &[RowSnapshot]) -> Vec<DirtyRow> {
    let mut out = Vec::new();
    for (i, row) in next.iter().enumerate() {
        match prev.get(i) {
            Some(p) if p == row => {}
            _ => out.push(DirtyRow {
                row: i as u16,
                spans: row.spans.clone(),
            }),
        }
    }
    out
}

/* ------------------------------------------------------------------
   Shell integration — drops a .zshrc that emits OSC 133 markers + an
   empty PS1, spawned zsh sees it via ZDOTDIR. Lets the BlockSegmenter
   close blocks at the right boundaries, and hides the noisy host/cwd
   prompt that duplicated our breadcrumb pill bar.
   ------------------------------------------------------------------ */

const ZSH_INTEGRATION: &str = r#"# GLI shell integration — auto-generated, do not edit.
# Sources the user's real configuration first, then installs OSC 133
# semantic-prompt markers + OSC 7 cwd reporting + an empty PROMPT.
# The empty PROMPT is intentional: GLI's chrome already shows folder
# / branch / diff in a pill row above the input, so the shell's own
# host@machine cwd % line would just duplicate that and eat vertical
# space inside every closed block.

# Save the integration ZDOTDIR before any user config can clobber it.
GLI_INTEGRATION_DIR="$ZDOTDIR"

# Restore the original ZDOTDIR (or fall back to HOME) so the user's
# real .zshrc and the rest of zsh's config files (.zlogin, .zprofile,
# etc.) load from where the user keeps them.
if [ -n "$GLI_USER_ZDOTDIR" ]; then
    export ZDOTDIR="$GLI_USER_ZDOTDIR"
elif [ -n "$ZDOTDIR" ]; then
    unset ZDOTDIR
fi

# Source user config from its real location.
if [ -n "$ZDOTDIR" ] && [ -f "$ZDOTDIR/.zshrc" ]; then
    source "$ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi

# OSC 133 semantic-prompt markers. The segmenter on the Rust side
# slices the byte stream at these points to build per-command blocks.
#
#   A — prompt about to be drawn (also closes the previous command via D)
#   C — command output starts (preexec, after the user pressed Enter)
#
# We deliberately omit B (end-of-prompt) because the React-side
# PromptInput captures the user's input directly — far more reliable
# than fishing it out of the byte stream.
_rli_precmd() {
    local _exit=$?
    print -Pn "\e]133;D;${_exit}\a"
    print -Pn "\e]133;A\a"
    # Defensively re-empty PROMPT every time a prompt is about to draw.
    # Some Oh-My-Zsh / Powerlevel10k themes recompute PROMPT inside
    # their own precmd; appending us last in precmd_functions means we
    # run after them and the empty value wins.
    PROMPT=''
    RPROMPT=''
}
_rli_preexec() {
    print -Pn "\e]133;C\a"
}

# OSC 7 cwd reporting. Emitted on shell startup and on every cd, so
# the chrome's folder pill tracks the *live* terminal cwd instead of
# only the launch cwd.
_rli_chpwd() {
    print -Pn "\e]7;file://%m%d\a"
}

typeset -ag precmd_functions
typeset -ag preexec_functions
typeset -ag chpwd_functions
precmd_functions+=(_rli_precmd)
preexec_functions+=(_rli_preexec)
chpwd_functions+=(_rli_chpwd)

# Initial cwd report — fires once at startup so the pill shows the
# launch directory before any cd happens.
_rli_chpwd

# Initial PROMPT wipe — covers the very first prompt drawn before
# any precmd runs.
PROMPT=''
RPROMPT=''
"#;

/// Write the zsh integration script into the app data dir and return
/// the directory we want zsh to treat as its ZDOTDIR. Idempotent —
/// rewritten on every spawn so updates ship without manual cleanup.
fn ensure_zsh_integration_dir(app: &AppHandle<Wry>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("shell-integration").join("zsh");
    fs::create_dir_all(&dir).map_err(|e| format!("create integration dir: {e}"))?;
    let path = dir.join(".zshrc");
    fs::write(&path, ZSH_INTEGRATION).map_err(|e| format!("write zshrc: {e}"))?;
    Ok(dir)
}

/* ------------------------------------------------------------------
   Tauri commands.
   ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct StartArgs {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
    /// Active project id (e.g. `p_rli_l2k4j`). Injected into the PTY's
    /// env as `RLI_PROJECT_ID` so in-pane agents and the `rli-memory`
    /// CLI can scope memory operations correctly. Optional only because
    /// older callers may not pass it; pass `None` and memory writes
    /// default to unscoped.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Active session id. Injected as `RLI_SESSION_ID`. Same intent as
    /// `project_id` but scoped one level finer.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[tauri::command]
pub fn term_start(
    app: AppHandle<Wry>,
    state: State<TerminalState>,
    args: StartArgs,
) -> Result<(), String> {
    // Idempotent path: if a PTY with this id is already alive, reuse
    // it and re-emit the full grid as a single "all rows dirty" frame
    // so the freshly-mounted React component can hydrate without ever
    // having seen the original startup events. This is what makes
    // session/project switches stop wiping the terminal — the React
    // component can unmount and remount freely; the PTY stays alive
    // and resyncs on each remount.
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&args.id).cloned() {
            drop(sessions);
            if let Ok(mut s) = existing.lock() {
                let snapshot = snapshot_grid(&s.term);
                let cursor = s.term.grid().cursor.point;
                let dirty: Vec<DirtyRow> = snapshot
                    .iter()
                    .enumerate()
                    .map(|(row, snap)| DirtyRow {
                        row: row as u16,
                        spans: snap.spans.clone(),
                    })
                    .collect();
                let seq = s.next_frame_seq;
                s.next_frame_seq = s.next_frame_seq.saturating_add(1);
                let frame = RenderFrame {
                    seq,
                    block_id: s.segmenter.current_block_id(),
                    cols: s.cols,
                    rows: s.rows,
                    cursor_row: cursor.line.0,
                    cursor_col: cursor.column.0 as u16,
                    alt_screen: s.term.mode().contains(TermMode::ALT_SCREEN),
                    command_running: s.last_command_running,
                    app_cursor: s.term.mode().contains(TermMode::APP_CURSOR),
                    bracketed_paste: s.term.mode().contains(TermMode::BRACKETED_PASTE),
                    dirty,
                };
                let _ = app.emit(&format!("term://{}/frame", args.id), &frame);
            }
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&args.command);
    cmd.args(&args.args);
    if let Some(cwd) = args.cwd.as_deref() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Tells `claude` / `codex` / hand-rolled shell scripts running inside
    // this PTY where to find the in-house browser daemon. Without this,
    // `claude` would reach for its `claude-in-chrome` MCP server (which
    // drives the user's real Chrome — not what we want for app testing).
    // The daemon binds 4000 by default; if it landed elsewhere it also
    // writes the chosen port to ~/Library/Application Support/dev.raeedz.gli/browser-port.
    // Both GLI_* (current) and RLI_* (legacy) names are exported so
    // user-side tooling that hardcodes either spelling keeps working
    // through the rename window.
    cmd.env("GLI_BROWSER_URL", "http://127.0.0.1:4000");
    cmd.env("RLI_BROWSER_URL", "http://127.0.0.1:4000");

    // Memory daemon discovery: the daemon picks a port at startup
    // (5555..5599) and writes it to `~/Library/.../memory-port`. We
    // also inject the URL directly so agents in this PTY can hit
    // /memory/{add,recall,extract} without parsing the port file.
    if let Some(port_state) = app.try_state::<crate::memory::daemon::MemoryDaemonPort>() {
        if let Some(port) = port_state.get() {
            let url = format!("http://127.0.0.1:{port}");
            cmd.env("GLI_MEMORY_URL", &url);
            cmd.env("RLI_MEMORY_URL", &url);
        }
    }
    // Per-pane scoping: in-pane agents (claude, codex) and the
    // gli-memory CLI read these to scope add/recall to the right
    // project + session without the user passing flags by hand.
    if let Some(pid) = args.project_id.as_deref() {
        cmd.env("GLI_PROJECT_ID", pid);
        cmd.env("RLI_PROJECT_ID", pid);
    }
    if let Some(sid) = args.session_id.as_deref() {
        cmd.env("GLI_SESSION_ID", sid);
        cmd.env("RLI_SESSION_ID", sid);
    }

    // For zsh, install our shell integration via ZDOTDIR. The
    // generated .zshrc emits OSC 133 markers (so the BlockSegmenter
    // can split commands into blocks) and clears PROMPT/RPROMPT so
    // the host/cwd prefix doesn't duplicate our pill bar.
    if args.command == "zsh" {
        if let Ok(dir) = ensure_zsh_integration_dir(&app) {
            // Stash the user's existing ZDOTDIR (if any) so the
            // integration script can chain-source from there.
            if let Ok(prev) = std::env::var("ZDOTDIR") {
                cmd.env("GLI_USER_ZDOTDIR", prev);
            }
            cmd.env("ZDOTDIR", dir.to_string_lossy().into_owned());
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| classify_spawn_error(&args.command, &e.to_string()))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let proxy = EventProxy(app.clone(), args.id.clone());
    let dims = Dims {
        cols: args.cols as usize,
        rows: args.rows as usize,
    };
    let term = Term::new(TermConfig::default(), &dims, proxy);
    let initial_snapshot = snapshot_grid(&term);

    let session = Arc::new(Mutex::new(Session {
        term,
        parser: Processor::new(),
        pty_master: pair.master,
        pty_writer: writer,
        killer,
        cols: args.cols,
        rows: args.rows,
        last_snapshot: initial_snapshot,
        last_flush: Instant::now() - FRAME_THROTTLE,
        last_command_running: false,
        segmenter: BlockSegmenter::new(),
        next_frame_seq: 0,
    }));

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(args.id.clone(), session.clone());
    }

    // Reader thread.
    let id_for_reader = args.id.clone();
    let app_for_reader = app.clone();
    let session_for_reader = session.clone();
    thread::spawn(move || {
        // 64 KB read buffer — sized for big agent replies and large
        // pastes. Each read holds the session mutex to feed the
        // segmenter + parser, so larger reads = fewer mutex
        // acquisitions during a burst. Sized to one PTY-typical page
        // chunk; the kernel won't usually fill it, and that's fine —
        // we reuse the stack buffer every iteration.
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    let blocks = {
                        let mut s = match session_for_reader.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        // ORDER MATTERS — see comments below.
                        //
                        // 1) Run the segmenter FIRST so we know whether
                        //    this chunk contains an OSC 133 C (command
                        //    start). Doing this before the alacritty
                        //    parser means we can decide whether to wipe
                        //    the grid BEFORE the chunk's output bytes
                        //    are written into it.
                        let blocks = s.segmenter.feed(bytes);
                        let just_started = s.segmenter.take_command_just_started();
                        // 2) If C just fired, clear the grid + diff
                        //    baseline NOW. The previous command's TUI
                        //    (e.g. claude's UI after a Ctrl+C exit)
                        //    must not ghost into the next command's
                        //    live view.
                        //
                        //    PREVIOUSLY we ran parser.advance first and
                        //    cleared after — which wiped the new
                        //    command's first burst of output whenever
                        //    it shared a PTY read with the OSC 133 C
                        //    marker (very common for fast tools like
                        //    vite that print their banner in the same
                        //    tick zsh's preexec fires). The user saw
                        //    an empty live block and no "VITE ready in
                        //    Xms" text. Clearing first fixes that
                        //    — the parser then writes the chunk's
                        //    output bytes into a freshly-cleared grid.
                        if just_started {
                            s.last_snapshot.clear();
                            let Session { parser, term, .. } = &mut *s;
                            parser.advance(term, b"\x1b[2J\x1b[H");
                        }
                        // 3) Now feed the actual chunk to the alacritty
                        //    parser. The OSC 133 bytes themselves are
                        //    no-ops to alacritty (no registered
                        //    handler), so only the real terminal
                        //    payload lands in the grid.
                        {
                            let Session { parser, term, .. } = &mut *s;
                            parser.advance(term, bytes);
                        }
                        let cwd_change = s.segmenter.take_pending_cwd();
                        // Flush a frame if we're past the throttle window.
                        maybe_flush(&mut s, &app_for_reader, &id_for_reader);
                        if let Some(cwd) = cwd_change {
                            let _ = app_for_reader
                                .emit(&format!("term://{id_for_reader}/cwd"), cwd);
                        }
                        blocks
                    };
                    for block in blocks {
                        let _ = app_for_reader
                            .emit(&format!("term://{id_for_reader}/block"), block);
                    }
                }
            }
        }
        let _ = app_for_reader.emit(&format!("term://{id_for_reader}/exit"), ());
    });

    // Wait thread — child status to surface clean exits.
    let app_for_wait = app.clone();
    let id_for_wait = args.id.clone();
    thread::spawn(move || {
        let _ = child.wait();
        let _ = app_for_wait.emit(&format!("term://{id_for_wait}/exit"), ());
    });

    Ok(())
}

#[tauri::command]
pub fn term_input(
    state: State<TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    s.pty_writer.write_all(&data).map_err(|e| e.to_string())?;
    s.pty_writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    state: State<TerminalState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let arc = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&id).cloned().ok_or("unknown term session")?
    };
    let mut s = arc.lock().map_err(|e| e.to_string())?;
    s.cols = cols;
    s.rows = rows;
    s.term.resize(Dims {
        cols: cols as usize,
        rows: rows as usize,
    });
    s.pty_master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    s.last_snapshot.clear();
    Ok(())
}

#[tauri::command]
pub fn term_close(
    state: State<TerminalState>,
    id: String,
) -> Result<(), String> {
    let arc = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(arc) = arc {
        if let Ok(mut s) = arc.lock() {
            let _ = s.killer.kill();
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------
   Frame flush — throttled to ~60 Hz, only sends dirty rows.
   ------------------------------------------------------------------ */

fn maybe_flush(s: &mut Session, app: &AppHandle<Wry>, id: &str) {
    let cmd_running = s.segmenter.command_running();
    let cmd_running_changed = cmd_running != s.last_command_running;
    // Throttle paints only — state changes (command_running flip)
    // always go out immediately. Without this bypass, a Ctrl+C kill
    // can land within 16ms of the previous paint, hit the throttle,
    // and never get re-flushed because zsh's empty PROMPT produces
    // no further bytes for the reader loop to wake on. Frontend
    // would stay stuck in agent mode with PromptInput hidden.
    if !cmd_running_changed && s.last_flush.elapsed() < FRAME_THROTTLE {
        return;
    }
    let snapshot = snapshot_grid(&s.term);
    let dirty = diff_rows(&s.last_snapshot, &snapshot);
    if dirty.is_empty() && !cmd_running_changed {
        return;
    }
    let cursor = s.term.grid().cursor.point;
    let seq = s.next_frame_seq;
    s.next_frame_seq = s.next_frame_seq.saturating_add(1);
    let frame = RenderFrame {
        seq,
        block_id: s.segmenter.current_block_id(),
        cols: s.cols,
        rows: s.rows,
        cursor_row: cursor.line.0,
        cursor_col: cursor.column.0 as u16,
        alt_screen: s.term.mode().contains(TermMode::ALT_SCREEN),
        command_running: cmd_running,
        app_cursor: s.term.mode().contains(TermMode::APP_CURSOR),
        bracketed_paste: s.term.mode().contains(TermMode::BRACKETED_PASTE),
        dirty,
    };
    let _ = app.emit(&format!("term://{id}/frame"), &frame);
    s.last_snapshot = snapshot;
    s.last_flush = Instant::now();
    s.last_command_running = cmd_running;
}

/* ------------------------------------------------------------------
   Spawn-error classifier (carried over from pty.rs).
   ------------------------------------------------------------------ */

fn classify_spawn_error(command: &str, raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("no such file") || lower.contains("not found") || lower.contains("enoent") {
        format!("command not found: '{command}' — check it's installed and on PATH")
    } else if lower.contains("permission denied") {
        format!("permission denied launching '{command}'")
    } else {
        format!("spawn '{command}': {raw}")
    }
}

/* ------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- BlockSegmenter ---------- */

    fn osc(content: &str) -> Vec<u8> {
        let mut v = vec![0x1b, 0x5d];
        v.extend_from_slice(content.as_bytes());
        v.push(0x07);
        v
    }

    #[test]
    fn segmenter_emits_block_on_osc133_d() {
        // The transcript should now include the prompt bytes between
        // A and C, the (optional B-bracketed) input, AND the output —
        // a faithful replay of the block as it scrolled past.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(b"$ "); // prompt
        bytes.extend_from_slice(&osc("133;B"));
        bytes.extend_from_slice(b"ls");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"file1\nfile2\n");
        bytes.extend_from_slice(&osc("133;D;0"));

        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "ls");
        assert!(blocks[0].transcript.contains("$ "));
        assert!(blocks[0].transcript.contains("ls"));
        assert!(blocks[0].transcript.contains("file1\nfile2\n"));
        assert_eq!(blocks[0].exit_code, Some(0));
    }

    #[test]
    fn segmenter_closes_block_on_next_prompt_a_when_d_omitted() {
        // Some shells omit D — closing on the next A is a safety net.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;B"));
        bytes.extend_from_slice(b"echo hi");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"hi\n");
        // No D — instead the next prompt
        bytes.extend_from_slice(&osc("133;A"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "echo hi");
        assert!(blocks[0].transcript.contains("hi"));
        assert_eq!(blocks[0].exit_code, None);
    }

    #[test]
    fn segmenter_ignores_pre_first_prompt_output() {
        // Anything before the first A is dropped (login banner, etc.).
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"Welcome to zsh!\n");
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(&osc("133;B"));
        let blocks = seg.feed(&bytes);
        assert!(blocks.is_empty());
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn segmenter_handles_st_terminator() {
        // ESC \\ (ST) is the alternative OSC terminator. Must work
        // identically to BEL.
        let mut seg = BlockSegmenter::new();
        let mut bytes = vec![0x1b, 0x5d];
        bytes.extend_from_slice(b"133;A");
        bytes.extend_from_slice(&[0x1b, 0x5c]); // ST
        bytes.extend_from_slice(&[0x1b, 0x5d]);
        bytes.extend_from_slice(b"133;B");
        bytes.extend_from_slice(&[0x1b, 0x5c]);
        let _ = seg.feed(&bytes);
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn segmenter_tolerates_chunked_input() {
        // Bytes can arrive split across read() calls — feeding piece by
        // piece must produce the same block as feeding all at once.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        seg.feed(&osc("133;B"));
        seg.feed(b"pwd");
        seg.feed(&osc("133;C"));
        seg.feed(b"/home\n");
        let blocks = seg.feed(&osc("133;D;0"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].input, "pwd");
        assert!(blocks[0].transcript.contains("/home\n"));
    }

    #[test]
    fn segmenter_extracts_cwd_from_osc7() {
        // OSC 7 messages must surface as pending_cwd so the reader
        // thread can emit a Tauri event. URL-encoded spaces decode.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("7;file://localhost/Users/bob/My%20Projects/site"));
        assert_eq!(
            seg.take_pending_cwd().as_deref(),
            Some("/Users/bob/My Projects/site"),
        );
        // Drain semantics: once read, the pending value is gone.
        assert!(seg.take_pending_cwd().is_none());
    }

    #[test]
    fn segmenter_ignores_malformed_osc7() {
        // OSC 7 without `file://` — silently dropped, no crash, no
        // bogus pending_cwd.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("7;not-a-url"));
        assert!(seg.take_pending_cwd().is_none());
    }

    #[test]
    fn transcript_includes_prompt_bytes() {
        // Anything between A and D must end up in the block transcript.
        // This is what lets the user's Spaceship/p10k prompt render
        // inside the closed block as the natural header.
        let mut seg = BlockSegmenter::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&osc("133;A"));
        bytes.extend_from_slice(b"\x1b[34mPROMPT\x1b[0m ");
        bytes.extend_from_slice(&osc("133;C"));
        bytes.extend_from_slice(b"output\n");
        bytes.extend_from_slice(&osc("133;D;0"));
        let blocks = seg.feed(&bytes);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].transcript.contains("PROMPT"));
        // SGR styling preserved verbatim — frontend parses it.
        assert!(blocks[0].transcript.contains("\x1b[34m"));
    }

    #[test]
    fn segmenter_ignores_other_osc_codes() {
        // OSC 0 (set window title) must not interfere with state.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        seg.feed(&osc("0;new title"));
        seg.feed(&osc("133;B"));
        assert_eq!(seg.state, SegState::AwaitingCommand);
    }

    #[test]
    fn command_running_only_true_between_c_and_d() {
        // Drives the live-frame visibility on the frontend. Must be
        // false before C, true between C and D, false after D.
        let mut seg = BlockSegmenter::new();
        assert!(!seg.command_running());
        seg.feed(&osc("133;A"));
        assert!(!seg.command_running()); // prompt drawing
        seg.feed(&osc("133;B"));
        assert!(!seg.command_running()); // awaiting input
        seg.feed(&osc("133;C"));
        assert!(seg.command_running()); // command actively producing output
        seg.feed(b"some output");
        assert!(seg.command_running()); // still streaming
        seg.feed(&osc("133;D;0"));
        assert!(!seg.command_running()); // command finished
    }

    #[test]
    fn command_just_started_latches_on_c() {
        // Reader thread reads & clears this to know when to nuke the
        // last_snapshot baseline so the new command paints fresh.
        let mut seg = BlockSegmenter::new();
        seg.feed(&osc("133;A"));
        assert!(!seg.take_command_just_started());
        seg.feed(&osc("133;C"));
        assert!(seg.take_command_just_started()); // first read returns true
        assert!(!seg.take_command_just_started()); // and clears
    }

    /* ---------- spawn-error classifier (regression from pty.rs) ---------- */

    #[test]
    fn missing_command_friendly_error() {
        let msg = classify_spawn_error("claude", "No such file or directory");
        assert!(msg.contains("command not found"));
        assert!(msg.contains("claude"));
    }

    /* ---------- Color → CSS ---------- */

    #[test]
    fn rgb_color_serializes_to_hex() {
        let css = color_to_css(
            Color::Spec(Rgb { r: 255, g: 0, b: 128 }),
            "x",
        );
        assert_eq!(css, "#ff0080");
    }

    #[test]
    fn indexed_palette_color_resolves() {
        // index 1 = ANSI red
        assert_eq!(color_to_css(Color::Indexed(1), "x"), ANSI_16[1]);
    }

    #[test]
    fn named_foreground_uses_css_var() {
        let css = color_to_css(Color::Named(NamedColor::Foreground), "x");
        assert!(css.starts_with("var("));
    }

    /* ---------- frame diffing ---------- */

    #[test]
    fn diff_returns_only_changed_rows() {
        let row_a = RowSnapshot {
            spans: vec![Span {
                text: "a".into(),
                fg: "x".into(),
                bg: "y".into(),
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
                dim: false,
                strikeout: false,
            }],
        };
        let row_b = RowSnapshot {
            spans: vec![Span {
                text: "b".into(),
                fg: "x".into(),
                bg: "y".into(),
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
                dim: false,
                strikeout: false,
            }],
        };
        let prev = vec![row_a.clone(), row_a.clone(), row_a.clone()];
        let next = vec![row_a.clone(), row_b.clone(), row_a.clone()];
        let diff = diff_rows(&prev, &next);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].row, 1);
    }
}
