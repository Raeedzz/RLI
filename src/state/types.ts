export type ProjectId = string;
export type WorktreeId = string;
export type TabId = string;
export type PtyId = string;
export type ArchiveId = string;

/**
 * The chrome ships in three persistent column families:
 *   sidebar (projects + worktrees) | main column (tabs) | right panel
 */

export type AgentCli = "claude" | "codex" | "gemini";

export type AgentStatus = "idle" | "running";

/** Workshop-pigment palette — see tokens.css `--tag-*` */
export type TagId =
  | "default"
  | "rust"
  | "amber"
  | "moss"
  | "pine"
  | "slate"
  | "iris"
  | "rose";

export const TAG_IDS: readonly TagId[] = [
  "default",
  "rust",
  "amber",
  "moss",
  "pine",
  "slate",
  "iris",
  "rose",
];

export function tagVar(tag: TagId | undefined): string {
  return `var(--tag-${tag ?? "default"})`;
}

/* ------------------------------------------------------------------
   Project — a git repo on disk. One row in the sidebar's Projects
   section. Expanded reveals its worktrees.
   ------------------------------------------------------------------ */

export interface Project {
  id: ProjectId;
  path: string;
  name: string;
  /** 1–2 character glyph fallback used when no favicon resolved. */
  glyph: string;
  /** Resolved at scan time; data URI if found. Null if no icon source. */
  faviconDataUri: string | null;
  pinned: boolean;
  /** Sidebar expand-collapse state. */
  expanded: boolean;
  /** User-assigned color tag. */
  color?: TagId;
}

/* ------------------------------------------------------------------
   Worktree — a git worktree of a project. Owns its own tabs, a chatbox
   target, and a secondary terminal in the right panel.
   ------------------------------------------------------------------ */

export type RightPanelTab = "files" | "changes" | "checks" | "memory";
export type SecondaryTab = "setup" | "run" | "terminal";

export interface Worktree {
  id: WorktreeId;
  projectId: ProjectId;
  /** Branch checked out in the worktree, e.g. `fix-enrich-phase-stuck`. */
  branch: string;
  /** User label, e.g. "Fix enrich phase stuck". */
  name: string;
  /** Absolute worktree checkout dir. */
  path: string;
  /** +N changes count from `git_status`. Polled. */
  changeCount: number;
  agentStatus: AgentStatus;
  agentCli: AgentCli | null;
  createdAt: number;

  /** Tabs (terminal / diff / markdown) in the main column for this worktree. */
  tabIds: TabId[];
  activeTabId: TabId | null;

  /** Right-panel selected tab and split position. */
  rightPanel: RightPanelTab;
  /** Vertical split between right-panel upper and the secondary terminal. */
  rightSplitPct: number;
  secondaryTab: SecondaryTab;
  /**
   * Each entry is a separate PTY rendered as its own tab in the secondary
   * panel. Created lazily — the first one is seeded from the legacy
   * `secondaryPtyId` so existing state migrates cleanly.
   */
  secondaryTerminals: PtyId[];
  /** Which secondaryTerminals[] entry is currently visible. */
  secondaryActiveTerminalId: PtyId | null;
  /** Legacy single-PTY id. Kept for migration; do not read directly. */
  secondaryPtyId: PtyId;
  /** When true, the secondary panel is minimized to just its tab header. */
  secondaryCollapsed?: boolean;

  /** User-assigned color tag (sidebar accent). */
  color?: TagId;
}

/* ------------------------------------------------------------------
   Tab — what shows in the main column. Three kinds for v1.
   ------------------------------------------------------------------ */

export type MarkdownMode = "diff" | "preview" | "edit";

interface TabBase {
  id: TabId;
  worktreeId: WorktreeId;
  /** Top line on the tab strip. Auto-generated for terminal tabs from
      the user's first prompt, or filename for diff/markdown tabs. */
  title: string;
  /** 11px tertiary line under the title — live activity for terminals,
      file path for diff/markdown. The differentiator. */
  summary: string;
  summaryUpdatedAt: number;
}

export interface TerminalTab extends TabBase {
  kind: "terminal";
  ptyId: PtyId;
  /** Detected CLI (set by helper-agent detection on each prompt block). */
  detectedCli: AgentCli | null;
  agentStatus: AgentStatus;
}

export interface DiffTab extends TabBase {
  kind: "diff";
  filePath: string;
  staged: boolean;
}

export interface MarkdownTab extends TabBase {
  kind: "markdown";
  filePath: string;
  mode: MarkdownMode;
  /** In-memory cache of file content; written on edit, persisted by autosave. */
  content: string | null;
}

export type Tab = TerminalTab | DiffTab | MarkdownTab;

/* ------------------------------------------------------------------
   Archive — a previously-active worktree, persisted on close.
   Restorable from the History section.
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Settings — user preferences. Persisted across launches.
   ------------------------------------------------------------------ */

export type CompletionSound = "none" | "subtle" | "bell";
export type ArchiveBehavior = "stash" | "force" | "ask";

export interface Settings {
  /** Show a macOS notification when an agent in a worktree goes idle. */
  notifyOnIdle: boolean;
  /** Play a sound when an agent in a worktree goes idle. */
  completionSound: CompletionSound;
  /**
   * Always render the breadcrumb's `n% / 5h` Anthropic-window pill,
   * even when no Claude transcript was found. Off by default — the
   * pill self-hides when there's no active session, matching the
   * "boring on purpose" .impeccable.md discipline.
   */
  alwaysShowContextUsage: boolean;
  /**
   * Prevent the system from sleeping while any worktree's agent is
   * running. Implemented via macOS `caffeinate -di` once the backend
   * command lands (TODO).
   */
  caffeinate: boolean;
  /**
   * Which CLI to spawn for helper operations (PR drafting, commit
   * messages, AskCard) when the active worktree hasn't detected one.
   * Acts as the fallback when a per-task override below isn't set
   * explicitly — kept for backwards compat with v2 saved state.
   */
  defaultHelperCli: AgentCli;
  /** CLI used to draft commit messages (right-panel "AI draft" button). */
  helperCliCommit: AgentCli;
  /**
   * Optional model name passed to the commit-message CLI via
   * `--model <name>`. Empty string = let the CLI pick its own default.
   * Strings are CLI-specific; switching `helperCliCommit` clears this.
   */
  helperModelCommit: string;
  /** CLI used to draft PR titles + bodies in the Create-PR dialog. */
  helperCliPr: AgentCli;
  /** Optional `--model <name>` for PR drafting. */
  helperModelPr: string;
  /** CLI used by the editor's ⌘L "Ask" overlay to explain selected code. */
  helperCliExplain: AgentCli;
  /** Optional `--model <name>` for the explain overlay. */
  helperModelExplain: string;
  /**
   * Drive the helper-agent–driven tab-summary polling. Off skips the
   * subprocess invocations — the tab subtitle then shows the launch
   * command (cheaper if you're running many parallel agents).
   */
  autoSummarize: boolean;
  /**
   * Default behavior when archiving a worktree from the sidebar.
   *   stash → `git stash push -u` then `git worktree remove`.
   *   force → `git worktree remove --force` (drops dirty changes).
   *   ask   → prompt each time.
   */
  archiveBehavior: ArchiveBehavior;
}

/** Resize bounds for the side columns. Reducer clamps writes here. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 248;
export const RIGHT_MIN = 280;
export const RIGHT_MAX = 720;
export const RIGHT_DEFAULT = 372;

export function clampSidebar(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

export function clampRight(w: number): number {
  if (Number.isNaN(w)) return RIGHT_DEFAULT;
  return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(w)));
}

export const DEFAULT_SETTINGS: Settings = {
  notifyOnIdle: true,
  completionSound: "subtle",
  alwaysShowContextUsage: false,
  caffeinate: true,
  defaultHelperCli: "claude",
  helperCliCommit: "claude",
  helperModelCommit: "",
  helperCliPr: "claude",
  helperModelPr: "",
  helperCliExplain: "claude",
  helperModelExplain: "",
  autoSummarize: true,
  archiveBehavior: "stash",
};

export interface ArchiveRecord {
  id: ArchiveId;
  projectId: ProjectId;
  branch: string;
  name: string;
  createdAt: number;
  archivedAt: number;
  lastSummary: string;
  changeCountAtArchive: number;
  /** Original worktree checkout path — the restore target. */
  originalPath: string;
  agentCli: AgentCli | null;
  /** Stash ref iff archive used `stash` option. */
  stashRef?: string;
}

/* ------------------------------------------------------------------
   App state
   ------------------------------------------------------------------ */

export interface AppState {
  /** Project records keyed by id. */
  projects: Record<ProjectId, Project>;
  /** Display order in the sidebar. */
  projectOrder: ProjectId[];

  /** Worktree records keyed by id. */
  worktrees: Record<WorktreeId, Worktree>;

  /** Tab records keyed by id. */
  tabs: Record<TabId, Tab>;

  activeProjectId: ProjectId | null;
  activeWorktreeByProject: Record<ProjectId, WorktreeId | null>;

  archivedWorktrees: ArchiveRecord[];

  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;

  /** Resizable column widths in px. Persisted across launches; clamped
      to [SIDEBAR_MIN, SIDEBAR_MAX] / [RIGHT_MIN, RIGHT_MAX] at the
      reducer boundary so out-of-bounds blobs can't break the layout. */
  sidebarWidth: number;
  rightPanelWidth: number;

  paletteOpen: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  prDialogOpen: { worktreeId: WorktreeId } | null;

  settings: Settings;
  markdownView: "rich" | "source";
}

/* ------------------------------------------------------------------
   Reducer actions
   ------------------------------------------------------------------ */

export type AppAction =
  // Projects
  | { type: "set-active-project"; id: ProjectId }
  | { type: "add-project"; project: Project }
  | { type: "remove-project"; id: ProjectId }
  | { type: "reorder-projects"; ids: ProjectId[] }
  | { type: "set-project-expanded"; id: ProjectId; expanded: boolean }
  | { type: "set-project-color"; id: ProjectId; color: TagId | undefined }

  // Worktrees
  | { type: "add-worktree"; worktree: Worktree }
  | { type: "update-worktree"; id: WorktreeId; patch: Partial<Worktree> }
  | { type: "set-active-worktree"; projectId: ProjectId; worktreeId: WorktreeId }
  | { type: "archive-worktree"; id: WorktreeId; record: ArchiveRecord }
  | { type: "restore-worktree"; archiveId: ArchiveId; worktree: Worktree }
  | { type: "set-right-panel"; worktreeId: WorktreeId; panel: RightPanelTab }
  | { type: "set-secondary-tab"; worktreeId: WorktreeId; tab: SecondaryTab }
  | { type: "add-secondary-terminal"; worktreeId: WorktreeId }
  | { type: "select-secondary-terminal"; worktreeId: WorktreeId; ptyId: PtyId }
  | { type: "close-secondary-terminal"; worktreeId: WorktreeId; ptyId: PtyId }
  | { type: "toggle-secondary-collapsed"; worktreeId: WorktreeId }
  | { type: "set-right-split-pct"; worktreeId: WorktreeId; pct: number }
  | { type: "set-agent-status"; worktreeId: WorktreeId; status: AgentStatus; cli?: AgentCli | null }
  | { type: "set-change-count"; worktreeId: WorktreeId; count: number }

  // Tabs
  | { type: "open-tab"; tab: Tab; activate?: boolean }
  | { type: "close-tab"; id: TabId }
  | { type: "select-tab"; worktreeId: WorktreeId; id: TabId }
  | { type: "update-tab"; id: TabId; patch: Partial<Tab> }
  | { type: "set-tab-summary"; id: TabId; summary: string }

  // Chrome
  | { type: "toggle-sidebar" }
  | { type: "toggle-right-panel" }
  | { type: "set-sidebar-width"; width: number }
  | { type: "set-right-panel-width"; width: number }
  | { type: "toggle-palette" }
  | { type: "set-palette"; open: boolean }
  | { type: "toggle-search" }
  | { type: "set-search"; open: boolean }
  | { type: "set-pr-dialog"; worktreeId: WorktreeId | null }
  | { type: "set-settings-open"; open: boolean }
  | { type: "toggle-settings" }
  | { type: "update-settings"; patch: Partial<Settings> }
  | { type: "set-markdown-view"; view: "rich" | "source" }

  // Persistence
  | { type: "hydrate"; state: Partial<AppState> };

/* ------------------------------------------------------------------
   Backwards-compat re-exports.
   The previous schema used `Session` and `OpenFile`. A handful of
   callers still import these names; we export aliases pointing at
   the closest replacement so legacy code keeps compiling during the
   incremental migration. New code should use Worktree/Tab directly.
   ------------------------------------------------------------------ */

/** @deprecated alias to Worktree for legacy callers. */
export type Session = Worktree;
/** @deprecated alias to WorktreeId for legacy callers. */
export type SessionId = WorktreeId;
/** @deprecated marker — used by some legacy code paths. */
export interface OpenFile {
  path: string;
  content: string;
}
/**
 * @deprecated kept as a thin status enum so legacy primitives (StatusDot)
 * still compile. New code uses {@link AgentStatus} directly.
 */
export type SessionStatus = "idle" | "streaming" | "error";
