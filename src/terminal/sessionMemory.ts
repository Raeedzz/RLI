/**
 * Module-scoped store of per-terminal-session UI state that needs to
 * survive React unmount.
 *
 * Why this exists: switching sessions/projects unmounts the workspace
 * tree, which means BlockTerminal's `blocks` (closed-command log) and
 * `history` (typed-input ring) are lost — even though the PTY may
 * still be running on the Rust side. Storing them here in module
 * scope means they live for the lifetime of the page, not the lifetime
 * of any component.
 *
 * Cap: blocks are capped per session at MAX_BLOCKS to bound memory.
 */
import type { Block } from "./types";

const MAX_BLOCKS = 500;
const MAX_HISTORY = 100;

interface Memory {
  blocks: Block[];
  history: string[];
}

const store = new Map<string, Memory>();

function ensure(id: string): Memory {
  let m = store.get(id);
  if (!m) {
    m = { blocks: [], history: [] };
    store.set(id, m);
  }
  return m;
}

export function getBlocks(id: string): Block[] {
  return ensure(id).blocks;
}

export function setBlocks(id: string, blocks: Block[]): void {
  const m = ensure(id);
  m.blocks = blocks.length > MAX_BLOCKS ? blocks.slice(-MAX_BLOCKS) : blocks;
}

export function getHistory(id: string): string[] {
  return ensure(id).history;
}

export function setHistory(id: string, history: string[]): void {
  const m = ensure(id);
  m.history = history.length > MAX_HISTORY ? history.slice(0, MAX_HISTORY) : history;
}

/**
 * Drop a session's stored memory. Call this when the session itself is
 * being permanently removed (e.g. user closes the tab) — not on
 * routine session switches.
 */
export function forgetSession(id: string): void {
  store.delete(id);
}
