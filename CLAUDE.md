# RLI capabilities (for in-pane agents)

You are running inside an RLI terminal pane. Use these.

## Memory — `rli-memory`

Per-project persistent memory. Auto-scoped via `$RLI_PROJECT_ID`.

- `rli-memory recall "<query>"` — search facts before answering project questions.
- `rli-memory add "<fact>"` — store a fact you discover. Dedupes automatically.

## Browser — `$RLI_BROWSER_URL` (`:4000`)

In-house headless Chrome daemon. Drive it with `curl` to test web apps the user is building.

- `curl -s $RLI_BROWSER_URL/health` — confirm it's up.
- `curl -s $RLI_BROWSER_URL/status` — `{ url, title, ready }` for the current page.
- `curl -X POST $RLI_BROWSER_URL/navigate -d '{"url":"http://localhost:3000"}' -H 'content-type: application/json'`
- `curl -s $RLI_BROWSER_URL/screenshot -o /tmp/s.png` — PNG bytes; pipe to your vision tool.
- `curl -X POST $RLI_BROWSER_URL/click -d '{"x":120,"y":80}' -H 'content-type: application/json'`
- `curl -X POST $RLI_BROWSER_URL/type -d '{"text":"hello"}' -H 'content-type: application/json'`
- `curl -X POST $RLI_BROWSER_URL/key -d '{"key":"Enter"}' -H 'content-type: application/json'`
- `curl -s $RLI_BROWSER_URL/console/recent` — recent console + network logs after a navigate.
- Also `/back`, `/forward`, `/reload` (POST, no body).

Typical loop: `navigate` → `screenshot` → read pixels → `click`/`type` → `screenshot` again. Use `/console/recent` to catch JS errors.

## Multi-agent tips

You may be one of several agents running in parallel panes of the same project.

- Coordinate via `rli-memory`, not scratch files — every agent reads the same store.
- Each pane has its own PTY and cwd; assume your peers cannot see your shell state.
- Before starting work, `rli-memory recall` for prior decisions. After finishing, `add` what's worth keeping.
- Distinguish your work from peers by checking the git branch (sessions are isolated worktrees).
