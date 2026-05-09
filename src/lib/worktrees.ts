import { invoke } from "@tauri-apps/api/core";
import type {
  AppState,
  ArchiveRecord,
  ProjectId,
  TerminalTab,
  Worktree,
  WorktreeId,
} from "@/state/types";

/**
 * Worktree lifecycle wrappers around the Rust commands. Backend lives
 * in `src-tauri/src/worktree.rs`.
 */

export async function worktreeList(projectPath: string): Promise<Worktree[]> {
  return invoke<Worktree[]>("worktree_list", { projectPath });
}

export async function worktreeCreate(
  projectId: string,
  projectPath: string,
  branch: string,
  label: string,
): Promise<Worktree> {
  return invoke<Worktree>("worktree_create", {
    projectId,
    projectPath,
    branch,
    label,
  });
}

export interface ArchiveOptions {
  /** Stash dirty changes before removing the worktree (recommended). */
  stash: boolean;
  /** Pass --force to git worktree remove. */
  force: boolean;
  /** Delete the local branch after removing. */
  deleteBranch: boolean;
}

export async function worktreeArchive(
  worktree: Worktree,
  opts: ArchiveOptions,
): Promise<ArchiveRecord> {
  return invoke<ArchiveRecord>("worktree_archive", {
    worktreeId: worktree.id,
    projectId: worktree.projectId,
    branch: worktree.branch,
    name: worktree.name,
    path: worktree.path,
    createdAt: worktree.createdAt,
    lastSummary: "",
    changeCountAtArchive: worktree.changeCount,
    agentCli: worktree.agentCli,
    stash: opts.stash,
    force: opts.force,
    deleteBranch: opts.deleteBranch,
  });
}

export async function worktreeRestore(
  archiveId: string,
  projectId: string,
): Promise<Worktree> {
  return invoke<Worktree>("worktree_restore", { archiveId, projectId });
}

export async function archiveList(
  projectId: string,
): Promise<ArchiveRecord[]> {
  return invoke<ArchiveRecord[]>("archive_list", { projectId });
}

export type { WorktreeId };

/**
 * Build the primary terminal tab record for a freshly-created worktree.
 * The backend mints a stable tab id in `worktree.tabIds[0]` but does
 * not write the actual Tab record — that's the frontend's job, since
 * `Tab` carries runtime fields (PTY id, summary text, agent status).
 *
 * Both ⌘N and the sidebar `+` button funnel through this so a new
 * worktree always opens onto a live shell instead of an empty pane.
 */
export function primaryTerminalTab(worktree: Worktree): TerminalTab {
  const id = worktree.tabIds[0] ?? `t_${Math.random().toString(36).slice(2, 10)}`;
  const ptyId = `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    worktreeId: worktree.id,
    kind: "terminal",
    ptyId,
    detectedCli: null,
    agentStatus: "idle",
    title: "shell",
    summary: "ready",
    summaryUpdatedAt: Date.now(),
  };
}

/**
 * Single-word landmark / monument names used as auto-generated branch
 * names. Picked deterministically (ordered by string hash so two
 * worktrees in the same project don't accidentally collide on the
 * same name) and sourced from a wide enough pool that the user can
 * make ~80 worktrees per project before we wrap to numeric fallbacks.
 *
 * Rules: lowercase, ASCII-only, hyphens not underscores (git branch
 * legal everywhere), no whitespace. Curated for memorability — the
 * user reads them at a glance in the sidebar, so distinct first
 * syllables matter more than depth.
 */
const LANDMARK_NAMES: readonly string[] = [
  "eiffel",
  "stonehenge",
  "colosseum",
  "parthenon",
  "pyramid",
  "kremlin",
  "pantheon",
  "acropolis",
  "petra",
  "machu-picchu",
  "alhambra",
  "angkor",
  "borobudur",
  "chichen-itza",
  "moai",
  "sphinx",
  "taj-mahal",
  "notre-dame",
  "sagrada",
  "duomo",
  "louvre",
  "uffizi",
  "prado",
  "hermitage",
  "vatican",
  "sistine",
  "westminster",
  "tower-bridge",
  "big-ben",
  "buckingham",
  "windsor",
  "edinburgh",
  "neuschwanstein",
  "brandenburg",
  "rijksmuseum",
  "anne-frank",
  "auschwitz",
  "matterhorn",
  "mont-blanc",
  "everest",
  "kilimanjaro",
  "fuji",
  "denali",
  "rushmore",
  "liberty",
  "brooklyn",
  "manhattan",
  "chrysler",
  "empire",
  "guggenheim",
  "moma",
  "white-house",
  "lincoln",
  "jefferson",
  "alamo",
  "hoover",
  "yosemite",
  "yellowstone",
  "grand-canyon",
  "niagara",
  "banff",
  "louvre-pyramid",
  "versailles",
  "champs",
  "trevi",
  "ponte-vecchio",
  "san-marco",
  "rialto",
  "leaning-tower",
  "sydney-opera",
  "harbour-bridge",
  "uluru",
  "great-wall",
  "forbidden-city",
  "summer-palace",
  "kinkaku",
  "fushimi",
  "itsukushima",
  "shwedagon",
  "bagan",
  "victoria-falls",
  "table-mountain",
  "kruger",
  "serengeti",
  "ngorongoro",
  "iguazu",
  "amazon",
  "atacama",
  "patagonia",
  "torres-del-paine",
  "santorini",
  "meteora",
  "hagia-sophia",
  "blue-mosque",
  "cappadocia",
  "ephesus",
  "masada",
  "wailing-wall",
  "bethlehem",
  "dome-of-the-rock",
];

/**
 * Compute the next auto-named branch for a project. Picks an unused
 * landmark name; falls back to `landmark-N` when the curated pool is
 * exhausted (~100 worktrees deep). Branch names that already follow
 * the legacy `agent-N` shape still count as "used" so old saved state
 * doesn't clash with new ones.
 */
export function nextAutoBranch(
  projectId: ProjectId,
  state: Pick<AppState, "worktrees" | "archivedWorktrees">,
): string {
  const used = new Set<string>();
  for (const w of Object.values(state.worktrees)) {
    if (w.projectId !== projectId) continue;
    used.add(w.branch.toLowerCase());
  }
  for (const a of state.archivedWorktrees) {
    if (a.projectId !== projectId) continue;
    used.add(a.branch.toLowerCase());
  }
  // Walk the landmark list deterministically, but jump to a hashed
  // start index based on the project id so two projects don't both
  // open with `eiffel` first.
  const start = hashStart(projectId, LANDMARK_NAMES.length);
  for (let i = 0; i < LANDMARK_NAMES.length; i++) {
    const name = LANDMARK_NAMES[(start + i) % LANDMARK_NAMES.length];
    if (!used.has(name)) return name;
  }
  // Pool exhausted — append a numeric suffix to the first landmark.
  let n = 2;
  while (used.has(`${LANDMARK_NAMES[0]}-${n}`)) n++;
  return `${LANDMARK_NAMES[0]}-${n}`;
}

function hashStart(seed: string, mod: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % mod;
}
