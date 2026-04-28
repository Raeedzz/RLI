# RLI

**A confident, dark instrument for running CLI coding agents.**

RLI is a native macOS desktop app for orchestrating `claude`, `codex`, and friends. Think Cursor + Warp + Superhuman, ruthlessly minimal — every session lives in its own git worktree, every pane is splittable, every commit can be AI-drafted.

> Built with Tauri (Rust) + React/TypeScript. macOS only in v1.

---

## Highlights

- **Multi-session, worktree-isolated.** Each `claude`/`codex` session runs in its own `git worktree` on its own branch. Spawn five in parallel without stepping on each other.
- **PTY-first workspace.** No chat panel. Just real terminals with xterm.js + WebGL, the way your agents already think.
- **Recursive split panes.** Terminal, editor, and an in-house headless-browser pane — drag, swap, split, snap. Per-session layout persists.
- **In-house browser daemon.** A Chrome daemon at `127.0.0.1:4000` exposes `/screenshot`, `/navigate`, `/click`, `/type`, etc. — the same HTTP contract as gstack, so existing skill scripts work unmodified from any agent terminal.
- **AI commits, scoped right.** Stage in the git panel, hit `⌘⏎`, get a Gemini Flash-Lite-drafted commit message previewed before it lands. `⌘⇧⏎` to push (explicit only).
- **Highlight → ask.** Select code in the editor, press `⌘L`, get an inline floating answer card in the margin. No side panel, no thread.
- **Connections view.** Read-only summary of installed skills (`~/.claude/skills/`), MCPs, and plugins.

---

## Install

> **Note:** RLI is in active development. There are no signed releases yet — building from source is the supported path.

### Prerequisites

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Rust toolchain](https://rustup.rs)
- Xcode Command Line Tools — `xcode-select --install`

### Build

```bash
git clone https://github.com/raeedzzz/RLI.git
cd RLI
bun install
bun run tauri:dev      # dev build with HMR
bun run tauri:build    # production .app bundle
```

The production app lands at `src-tauri/target/release/bundle/macos/RLI.app`.

### First run

1. Press `⌘O` to open a project folder.
2. Press `⌘N` to start a new session — RLI creates a worktree at `<project>/.rli/sessions/<slug>` on a fresh branch.
3. Type your first prompt to the agent; the session name and branch get auto-slugged from it.

---

## Keyboard shortcuts

> v1 keymap is fixed. No remapping yet.

### Sessions & projects
| Chord | Action |
|---|---|
| `⌘O` | Open project |
| `⌘N` | New session in active project |
| `⌘W` | Close active session |
| `⌘1`–`⌘9` | Switch to nth session in active project |
| `⌘⌥1`–`⌘⌥9` | Jump directly to nth project |
| `⌘⇧1`–`⌘⇧9` | Jump directly to nth project (alternate binding) |

### Workspace panels
| Chord | Action |
|---|---|
| `⌘K` | Command palette |
| `⌘⇧F` | Search (`rg` / `ast-grep`) |
| `⌃⇧G` | Source-control panel |
| `⌘⇧;` | Connections view (skills + MCPs) |
| `⌘⇧B` | Toggle browser pane |

### Pane chords (new)

Press the prefix, then an arrow to choose which side the new pane lands on. The arrow is what fires the split — the prefix alone does nothing.

| Chord | Action |
|---|---|
| `⌘B` `←` `→` `↑` `↓` | Split active pane and open a **browser** on that side |
| `⌘E` `←` `→` `↑` `↓` | Split active pane and open an **editor** on that side |
| `⌘T` `←` `→` `↑` `↓` | Split active pane and open a **terminal** on that side |

`←`/`→` create a horizontal split (side-by-side); `↑`/`↓` create a vertical split (stacked). The chord expires after ~1.5s if no arrow follows.

### AI / git
| Chord | Action |
|---|---|
| `⌘L` | Highlight code → ask Flash-Lite |
| `⌘⏎` | Commit with AI-generated message (preview required) |
| `⌘⇧⏎` | Push (explicit only — never auto) |

---

## Architecture

- **Backend (Rust):** Tauri 2 host. PTY mux via `portable-pty`. fs watcher via `notify`. Git by shelling out. SQLite via `rusqlite` + `sqlite-vec` for the memory layer. Secrets in macOS Keychain via the `keyring` crate. Search via `rg` and `ast-grep` with `--json` parsing. Headless Chrome managed inside `src-tauri/src/browser/`.
- **Frontend (React + TS):** xterm.js + `xterm-addon-webgl` for terminals. CodeMirror 6 for the editor. `react-resizable-panels` for splits. `react-arborist` for the file tree. Motion (Framer) for chrome animations only — never on terminal contents or editor contents. `dnd-kit` for pane/tab drag.
- **Two-level navigation:** Project (a folder/repo) → Session (a `claude`/`codex` instance in its own worktree).
- **State:** All durable state in Rust + SQLite, surfaced via Tauri commands. No state hidden in components.
- **AI:** Single model — `gemini-3.1-flash-lite-preview` — for commit messages, highlight-and-ask, tab summaries, session naming. Gemini Embedding API for memory vectors. No local models.

See [`CONTEXT.md`](CONTEXT.md) for the full spec, including the locked v1 feature matrix.

---

## Project layout

```
src/                      React + TS frontend
  shell/                  AppShell, TopBar, ActivityRail, StatusBar
  workspace/              Recursive pane tree, drag/drop, split chooser
  terminal/               BlockTerminal, PromptInput, session memory
  editor/                 CodeMirror 6 wrapper
  browser/                Browser pane UI (talks to the Rust daemon)
  git/                    GitPanel, DiffView, AI commit flow
  files/                  FileTree, context menu
  connections/            Skills + MCP read-only view
  palette/                Command palette
  state/                  AppState reducer, pane tree helpers
  hooks/                  useKeyboardShortcuts, etc.
src-tauri/                Rust backend
  src/browser/            In-house headless-Chrome daemon
  src/                    Tauri commands, PTY mux, git, fs, memory
docs/                     Design notes, motion guidelines
```

---

## Storage paths (macOS)

- App data: `~/Library/Application Support/RLI/`
  - `rli.db` — SQLite (sessions, memory, settings cache)
  - `config.toml` — hand-editable settings
- Logs: `~/Library/Logs/RLI/rli.log` (rotated at 10 MB)
- Worktrees: `<project>/.rli/sessions/<slug>` (gitignored automatically)
- Secrets: macOS Keychain (Gemini API key only)

---

## Development

```bash
bun run dev           # Vite-only dev server (no Tauri shell)
bun run tauri:dev     # full app with HMR
bun run typecheck     # tsc -b
bun run test          # frontend tests (Bun)
bun run test:rs       # Rust tests
bun run test:all      # everything
```

---

## What's not in v1

Deliberate cuts to keep the surface area honest: chat panel for the agent, file-tree git status badges, settings UI, LSP/IntelliSense, preset keymaps or remapping, floating windows, telemetry, cross-platform builds, and a Python sidecar for memory. See `CONTEXT.md` for the full list.

---

## Contributing

Issues and PRs welcome. The codebase prizes:

- **Direct code over abstractions.** Three similar lines beats a premature helper.
- **No new files unless something needs them.** Edit existing modules first.
- **Animations only on chrome.** Never on terminal or editor contents.
- **Comments only when the *why* is non-obvious.** Names should explain the *what*.

If you're picking up a non-trivial task, open an issue first so we can sanity-check the approach.

---

## License

[MIT](LICENSE) © Raeed M. Zainuddin
