# RLI

A downloadable native desktop app — a beautiful, fast workspace for running CLI coding agents. Cursor + Warp + Superhuman, ruthlessly minimal, built for spawning and orchestrating `claude`, `codex`, and friends.

## What it is, in one paragraph

A Tauri desktop app. Rust backend, React + TypeScript frontend in the OS webview. Its job is to host CLI agents (PTY-based, no chat panel) inside a beautiful modular workspace, layered with a single small embedded model (`gemini-3.1-flash-lite-preview`) for commit messages, "highlight code → ask why," and tab summaries. Every session lives in its own git worktree on its own branch. macOS only v1.

## Locked spec

| # | User requirement | Implementation |
|---|---|---|
| 1 | Lightning fast | Tauri + Rust + React/TS. xterm.js + WebGL addon. Animations only on chrome (rails, tabs, palette, modals). Never on terminal contents or editor contents. `sqlite-vec` in-process. |
| 2 | Beautiful animations | Motion (Framer) on chrome only. Governed by `/animate` skill at build time. |
| 3 | Git stage/commit/push + AI commits | Shell out to `git`. AI commit msg from `gemini-3.1-flash-lite-preview` over `git diff --staged`. Always preview before commit. ⌘⏎ commit, ⌘⇧⏎ push (explicit only — never auto). |
| 4 | Show skills + MCPs | Combined connections view, palette-summoned (⌘⇧;), read-only. Reads `~/.claude/skills/`, `~/.claude/.mcp.json`, `~/.claude/settings.json`, project `.mcp.json`, `~/.claude/plugins/`. Status from latest Claude session log. Click a skill → preview SKILL.md in editor. |
| 5 + 6 | Multi-session, Warp-style minimal | **Top bar (36px)**: session tabs on the left (one per `claude`/`codex` instance, each in its own worktree, single-line with status dot + name) + project switcher pill on the right (`project: RLI ▾`). No left sidebar. **Default workspace = single agent terminal pane.** Splits are user-invoked: ⌘\\ split right (user terminal), ⌘⇧\\ split down (editor), ⌘B toggle file tree. Recursive resizable splits via `react-resizable-panels`. **Bottom 24px status bar** carries the active session's live subtitle (`● rli/branch · Refactoring AuthProvider…`) — that's where the hero "live tab summary" feature lives now. |
| 7 | Highlight code → ask | Inline only. CodeMirror 6 selection → ⌘L → small floating answer card in margin. Selection + 30 lines of context to Flash-Lite. |
| 8 | Embedded fast browser | RLI ships an **in-house headless-Chrome daemon** (`src-tauri/src/browser/`) on `127.0.0.1:4000` exposing the same HTTP contract gstack uses (`/health`, `/status`, `/screenshot`, `/console/recent`) plus POST routes for `/navigate`, `/click`, `/type`, `/key`, `/back`, `/forward`, `/reload`. ⌘⇧B opens a pane with a URL bar + clickable preview. The same daemon is reachable from a `claude` running in any RLI terminal pane via curl, so existing gstack skill scripts work unmodified. System Chrome is auto-detected; if missing, Chrome-for-Testing is downloaded on first use. |
| 9 | Tab summary on switch | Activity-driven. When agent PTY goes idle (3s silence + prompt regex match), strip ANSI from last 3KB, send to Flash-Lite, cache. Single-line summary in 11px text under the active tab name. Session **name** generated once from first user PTY input → branch slug. |
| 10 | Keyboard shortcuts everywhere | Pre-baked, fixed v1. Listed in palette. No remapping. |
| 11 | Memory system from GitHub | `sqlite-vec` (from GitHub) + FTS5 (built into SQLite) + Gemini Embedding API + ~200 LOC `memory.rs`. No Python sidecar. Stores per-session transcripts, Q&A pairs, per-project facts. Retrieval = vector similarity ⊕ FTS5 keyword ⊕ recency. |

## Architecture

- **Backend (Rust):** Tauri 2 host process. PTY mux via `portable-pty`. fs watcher via `notify`. Git via shelling out (`git2-rs` ruled out: incomplete write paths). SQLite via `rusqlite` + `sqlite-vec`. Secrets via `keyring` crate (macOS Keychain). Gemini calls via `reqwest`. Search via shelling out to `rg` and `ast-grep` with `--json` parsing.
- **Frontend (React + TS):** Webview UI. xterm.js + `xterm-addon-webgl` for terminals. CodeMirror 6 for editor. `react-resizable-panels` for splits. `react-arborist` for file tree. Motion for chrome animations. `dnd-kit` for tab/pane drag.
- **Two-level navigation:** Project (a folder/repo) → Session (a `claude`/`codex` instance in its own worktree).
- **Per-session layout:** Persisted per-session in SQLite. Pane tree is serializable.
- **No state hidden in components.** All durable state in Rust + SQLite, surfaced via Tauri commands.

## Sessions = git worktrees

- New session → `git worktree add .rli/sessions/<slug> -b rli/<slug>` off the current branch.
- Branch slug = sluggified Flash-Lite summary of the user's first prompt to the agent.
- Session close → modal: **Merge** (into source branch) / **Open PR** (`gh pr create`) / **Keep branch** / **Discard branch + worktree**.
- Non-git folders → fall back to shared cwd; warn that two sessions will collide.

## Storage paths (macOS)

- App data: `~/Library/Application Support/RLI/`
  - `rli.db` — SQLite (sessions, memory, settings cache)
  - `config.toml` — hand-editable settings
- Logs: `~/Library/Logs/RLI/rli.log` (rotated at 10MB)
- Worktrees: `<project>/.rli/sessions/<slug>` (in the project, gitignored automatically)
- Secrets: macOS Keychain via `keyring` crate (Gemini API key only)

## Keyboard map (v1, fixed)

- `⌘O` open project
- `⌘N` new session
- `⌘W` close session
- `⌘K` palette (general)
- `⌘⇧K` command palette (named actions)
- `⌘⇧F` search (`rg` / `ast-grep`)
- `⌘⇧;` connections view (skills + MCPs)
- `⌘B` toggle file tree
- `⌘\` split right
- `⌘⇧\` split down
- `⌘L` highlight-and-ask
- `⌘⇧B` browser pane (in-house daemon)
- `⌘⏎` commit with AI-generated message (preview required)
- `⌘⇧⏎` push (explicit only, never auto)

## What's NOT in v1 (deliberate cuts)

- Chat panel for the agent (it's a terminal, period)
- Browser auto-detect heuristic (manual ⌘⇧B only)
- File-tree git status badges
- Settings UI (hand-edit TOML)
- Pre-flight 7-binary health check on startup (lazy per-feature)
- Tab summary tooltip + header strip (only the inline 11px line under active tab)
- Highlight-and-ask side panel / thread / expand
- "Restart MCP" / "edit MCP" actions (read-only display)
- Floating windows
- Dock zones (recursive splits only)
- Preset keymaps / remapping
- Telemetry, crash reports, beta channel
- LSP / IntelliSense (the agent is the smart layer)
- Cross-platform (macOS only v1)
- Python sidecar for memory
- Bundling Chromium *with the .app* (we lazy-download Chrome-for-Testing on Chrome-less machines instead)

## Models

- **`gemini-3.1-flash-lite-preview`** — single model for all in-app AI: commit messages, highlight-and-ask, tab summaries, session naming.
- **Gemini Embedding API** — for memory layer vectors only.
- **No local model.** Slow + worse output, fights goal #1.
- **Agents themselves** = whatever the user runs in the PTY (Claude Code, Codex, etc.) — RLI does not decide for them.

## Design system directive

When implementing UI, **the `/frontend-design` skill is the visual authority** and **the `/animate` skill is the motion authority**. Invoke them — don't freelance. The aesthetic target is the intersection of Cursor (workspace), Warp (terminal), and Superhuman (speed + dark elegance + keyboard-first), with ruthless minimalism on top.

## Required external dependencies (user installs separately)

- `git` — assumed present
- `claude` and/or `codex` — at least one, for agent sessions
- `gh` — for PR creation on session merge-back
- `rg` (ripgrep) — for search
- `ast-grep` (`sg`) — for structural search
- *(optional)* a system Google Chrome / Chromium — used for the browser pane if present; otherwise Chrome-for-Testing is downloaded on first use to `~/Library/Application Support/RLI/chrome/`
- A Google AI / Gemini API key — entered on first AI feature use

RLI checks these lazily, only when the relevant feature is invoked. On miss: surface a clear message + the `brew install` command. Never auto-run installers.

## Out of scope forever (philosophical)

- RLI does not write code. The CLI agents do.
- RLI does not run a server.
- RLI does not phone home.
- RLI does not bundle a browser inside the `.app`. (It can lazily fetch Chrome-for-Testing into the user's Application Support directory if no system Chrome exists — the `.dmg` itself stays small.)
- RLI does not abstract over agents (no "RLI prompt format"). It is a host, not an SDK.
