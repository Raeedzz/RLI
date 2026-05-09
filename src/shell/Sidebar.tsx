import {
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  IconSidebar,
  IconBack,
  IconForward,
  IconHistory,
  IconFolderAdd,
  IconPlus,
  IconBranch,
  IconRunning,
  IconClose,
  IconHelp,
  IconSettings,
  IconTerminal,
  IconCheck,
} from "@/design/icons";
import {
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import type {
  AgentCli,
  ArchiveRecord,
  Project,
  Tab,
  Worktree,
} from "@/state/types";
import { openProjectDialog } from "@/lib/projectDialog";
import {
  worktreeArchive,
  worktreeCreate,
  worktreeRestore,
} from "@/lib/worktrees";
import { useToast } from "@/primitives/Toast";

/**
 * Left rail. Flat agent-card list — one card per worktree, regardless
 * of which project owns it. The project root is shown on the card
 * itself (`~/...`) instead of as a section header.
 *
 *   ┌─────────────────────────────┐
 *   │  ◯ todo.md          ╴       │  card chrome:
 *   │     ~/Developer             │   row 1: avatar + name (+ badge)
 *   │     ⌥ main                  │   row 2: project path
 *   │     wiring up the OSC…      │   row 3: branch
 *   └─────────────────────────────┘   row 4: live activity summary
 *
 * Active card: surface-3 fill + 2px accent left strip. Running agent:
 * pulsing accent dot on the avatar. Hover ✕ archives the worktree.
 */
export function Sidebar() {
  const state = useAppState();
  const activeWorktree = useActiveWorktree();

  if (state.sidebarCollapsed) {
    return <CollapsedRail />;
  }

  const allWorktrees = Object.values(state.worktrees);

  return (
    <div
      style={{
        height: "100%",
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto auto 1fr auto",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
      }}
    >
      <SidebarHeader />
      <HistorySection records={state.archivedWorktrees} />

      <div
        style={{
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "var(--space-2)",
        }}
      >
        <WorktreesHeader projects={state.projects} />
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {allWorktrees.map((worktree, i) => {
            const project = state.projects[worktree.projectId];
            if (!project) return null;
            const summary = pickSummary(worktree, state.tabs);
            return (
              <WorktreeCard
                key={worktree.id}
                worktree={worktree}
                project={project}
                summary={summary}
                isActive={activeWorktree?.id === worktree.id}
                index={i}
              />
            );
          })}
          {allWorktrees.length === 0 && (
            <li
              style={{
                padding: "var(--space-3)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-xs)",
              }}
            >
              No worktrees yet.
            </li>
          )}
        </ul>
      </div>

      <SidebarFooter />
    </div>
  );
}

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

/** Resolve the activity summary for a worktree — grab it from the
 *  active terminal tab, or the first terminal tab if the active is
 *  diff/markdown. Empty when the worktree has no terminals. */
function pickSummary(
  worktree: Worktree,
  tabs: Record<string, Tab>,
): string {
  const active = worktree.activeTabId ? tabs[worktree.activeTabId] : null;
  if (active?.kind === "terminal" && active.summary) return active.summary;
  for (const id of worktree.tabIds) {
    const t = tabs[id];
    if (t?.kind === "terminal" && t.summary) return t.summary;
  }
  return "";
}

/** Turn `/Users/raeedz/Developer/RLI` → `~/Developer/RLI`. */
function relHome(absPath: string): string {
  // Hardcoding $HOME is fine in v1 — RLI ships only as a Tauri DMG and
  // there's no environment-injection path on the renderer side.
  const home = "/Users/raeedz";
  if (absPath.startsWith(home)) return "~" + absPath.slice(home.length);
  return absPath;
}

/* ------------------------------------------------------------------
   Header rows
   ------------------------------------------------------------------ */

function SidebarHeader() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 var(--space-2)",
        borderBottom: "var(--border-1)",
        color: "var(--text-tertiary)",
      }}
    >
      <IconButton
        title="Collapse sidebar  ⌘B"
        onClick={() => dispatch({ type: "toggle-sidebar" })}
      >
        <IconSidebar size={16} />
      </IconButton>
      <div style={{ flex: 1 }} />
      <IconButton title="Back" disabled>
        <IconBack size={14} />
      </IconButton>
      <IconButton title="Forward" disabled>
        <IconForward size={14} />
      </IconButton>
    </div>
  );
}

function WorktreesHeader({
  projects,
}: {
  projects: Record<string, Project>;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();

  const onAdd = async () => {
    const ids = Object.keys(projects);
    if (ids.length === 0) {
      // No projects yet — open the picker.
      void openProjectDialog(dispatch);
      return;
    }
    // For v1 we always create the new worktree inside the most recently
    // active project. ⌘O picks a different project entirely.
    const projectId = ids[ids.length - 1];
    const project = projects[projectId];
    const branch = window.prompt("New branch name", "");
    if (!branch?.trim()) return;
    try {
      const w = await worktreeCreate(
        project.id,
        project.path,
        branch.trim(),
        branch.trim(),
      );
      dispatch({ type: "add-worktree", worktree: w });
    } catch (err) {
      toast.show({ message: `Worktree creation failed: ${err}` });
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 28,
        padding: "0 var(--space-1) 0 var(--space-2)",
        marginBottom: 4,
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-wide)",
      }}
    >
      <span>Worktrees</span>
      <span style={{ flex: 1 }} />
      <SmallIconButton
        title="Open project (⌘O)"
        onClick={() => void openProjectDialog(dispatch)}
      >
        <IconFolderAdd size={14} />
      </SmallIconButton>
      <SmallIconButton title="New worktree" onClick={onAdd}>
        <IconPlus size={14} />
      </SmallIconButton>
    </div>
  );
}

/* ------------------------------------------------------------------
   History
   ------------------------------------------------------------------ */

function HistorySection({ records }: { records: ArchiveRecord[] }) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "var(--border-1)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 30,
          width: "100%",
          padding: "0 var(--space-3)",
          color: "var(--text-secondary)",
          backgroundColor: "transparent",
        }}
      >
        <IconHistory size={14} />
        <span style={{ fontSize: "var(--text-sm)" }}>History</span>
        <span style={{ flex: 1 }} />
        {records.length > 0 && (
          <span
            className="tabular"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
            }}
          >
            {records.length}
          </span>
        )}
      </button>
      <div
        style={{
          display: "grid",
          gridTemplateRows: open && records.length > 0 ? "1fr" : "0fr",
          transition:
            "grid-template-rows var(--motion-base) var(--ease-out-quart)",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {records.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const w = await worktreeRestore(r.id, r.projectId);
                      dispatch({
                        type: "restore-worktree",
                        archiveId: r.id,
                        worktree: w,
                      });
                      toast.show({ message: `Restored ${r.name}` });
                    } catch (err) {
                      toast.show({ message: `Restore failed: ${err}` });
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: 26,
                    width: "100%",
                    padding: "0 var(--space-3) 0 28px",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-xs)",
                    backgroundColor: "transparent",
                  }}
                  onMouseOver={(e) =>
                    (e.currentTarget.style.backgroundColor = "var(--surface-2)")
                  }
                  onMouseOut={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textAlign: "left",
                    }}
                  >
                    {r.name}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-disabled)",
                    }}
                  >
                    {r.branch}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Worktree card
   ------------------------------------------------------------------ */

function WorktreeCard({
  worktree,
  project,
  summary,
  isActive,
  index,
}: {
  worktree: Worktree;
  project: Project;
  summary: string;
  isActive: boolean;
  index: number;
}) {
  const dispatch = useAppDispatch();
  const settings = useAppState().settings;
  const toast = useToast();
  const [hovering, setHovering] = useState(false);
  const isRunning = worktree.agentStatus === "running";

  const onSelect = () => {
    dispatch({ type: "set-active-project", id: project.id });
    dispatch({
      type: "set-active-worktree",
      projectId: project.id,
      worktreeId: worktree.id,
    });
  };

  const onArchive = async (e: MouseEvent) => {
    e.stopPropagation();
    let stash = settings.archiveBehavior !== "force";
    let force = settings.archiveBehavior === "force";
    if (settings.archiveBehavior === "ask") {
      const choice = window.confirm(
        `Archive ${worktree.name}?\n\nOK = stash dirty changes (recoverable from History)\nCancel = abort`,
      );
      if (!choice) return;
      stash = true;
      force = false;
    }
    try {
      const record = await worktreeArchive(worktree, {
        stash,
        force,
        deleteBranch: false,
      });
      dispatch({ type: "archive-worktree", id: worktree.id, record });
      toast.show({
        message: `Archived ${worktree.name}`,
        action: {
          label: "Restore",
          onClick: async () => {
            try {
              const restored = await worktreeRestore(record.id, project.id);
              dispatch({
                type: "restore-worktree",
                archiveId: record.id,
                worktree: restored,
              });
            } catch (err) {
              toast.show({ message: `Restore failed: ${err}` });
            }
          },
        },
      });
    } catch (err) {
      toast.show({ message: `Archive failed: ${err}` });
    }
  };

  const cardStyle: CSSProperties = {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "32px 1fr auto",
    gridColumnGap: 10,
    alignItems: "start",
    width: "100%",
    padding: "10px 10px 10px 12px",
    borderRadius: "var(--radius-md)",
    backgroundColor: isActive ? "var(--surface-3)" : "var(--surface-2)",
    boxShadow: isActive
      ? "inset 2px 0 0 0 var(--accent)"
      : "inset 2px 0 0 0 transparent",
    color: "var(--text-secondary)",
    textAlign: "left",
    border: "none",
    cursor: "default",
    transition:
      "background-color var(--motion-instant) var(--ease-out-quart)," +
      "box-shadow var(--motion-fast) var(--ease-out-quart)",
  };

  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.24,
        ease: [0.25, 1, 0.5, 1],
        delay: Math.min(index * 0.03, 0.21),
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        onClick={onSelect}
        style={cardStyle}
        onMouseOver={(e) => {
          if (!isActive)
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
        }}
        onMouseOut={(e) => {
          if (!isActive)
            e.currentTarget.style.backgroundColor = "var(--surface-2)";
        }}
      >
        <Avatar agentCli={worktree.agentCli} isRunning={isRunning} />

        <div style={{ minWidth: 0, display: "grid", gridRowGap: 2 }}>
          <span
            style={{
              fontSize: "var(--text-base)",
              fontWeight: "var(--weight-medium)",
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {worktree.name}
          </span>
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
            }}
          >
            {relHome(project.path)}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <IconBranch size={11} /> {worktree.branch}
          </span>
          <SummaryLine summary={summary} />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
          }}
        >
          {hovering && (
            <SmallIconButton title="Archive worktree" onClick={onArchive}>
              <IconClose size={12} />
            </SmallIconButton>
          )}
          {!hovering && worktree.changeCount > 0 && (
            <span
              className="tabular"
              style={{
                fontSize: "var(--text-2xs)",
                fontFamily: "var(--font-mono)",
                color: "var(--state-success)",
              }}
            >
              +{worktree.changeCount}
            </span>
          )}
        </div>
      </button>
    </motion.li>
  );
}

function SummaryLine({ summary }: { summary: string }) {
  const text = summary.replace(/\s+/g, " ").trim();
  return (
    <AnimatePresence mode="wait">
      <motion.span
        key={text || "idle"}
        initial={{ opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -3 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        style={{
          marginTop: 4,
          fontSize: "var(--text-2xs)",
          lineHeight: "var(--leading-2xs)",
          color: text ? "var(--text-secondary)" : "var(--text-disabled)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          whiteSpace: "normal",
          minHeight: "var(--leading-2xs)",
        }}
      >
        {text || "idle"}
      </motion.span>
    </AnimatePresence>
  );
}

function Avatar({
  agentCli,
  isRunning,
}: {
  agentCli: AgentCli | null;
  isRunning: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: 32,
        height: 32,
        borderRadius: "var(--radius-pill)",
        backgroundColor: "var(--surface-4)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-secondary)",
        flexShrink: 0,
      }}
    >
      {isRunning ? (
        <span className="rli-loader-spin" style={{ display: "inline-flex" }}>
          <IconRunning size={16} />
        </span>
      ) : (
        <IconTerminal size={16} />
      )}
      <AvatarBadge agentCli={agentCli} isRunning={isRunning} />
    </div>
  );
}

function AvatarBadge({
  agentCli,
  isRunning,
}: {
  agentCli: AgentCli | null;
  isRunning: boolean;
}) {
  if (!isRunning && !agentCli) return null;
  const bg = isRunning ? "var(--accent)" : "var(--state-success-bg)";
  const fg = isRunning ? "var(--surface-0)" : "var(--state-success)";
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: 14,
        height: 14,
        borderRadius: "var(--radius-pill)",
        border: "2px solid var(--surface-1)",
        backgroundColor: bg,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isRunning ? (
        <span
          aria-hidden
          style={{
            width: 4,
            height: 4,
            borderRadius: "var(--radius-pill)",
            backgroundColor: "var(--surface-0)",
          }}
        />
      ) : (
        <IconCheck size={9} strokeWidth={2.4} />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------
   Footer
   ------------------------------------------------------------------ */

function SidebarFooter() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 4,
        padding: "0 var(--space-2)",
        borderTop: "var(--border-1)",
      }}
    >
      <IconButton title="Help">
        <IconHelp size={16} />
      </IconButton>
      <IconButton
        title="Settings  ⌘,"
        onClick={() => dispatch({ type: "set-settings-open", open: true })}
      >
        <IconSettings size={16} />
      </IconButton>
    </div>
  );
}

/* ------------------------------------------------------------------
   Primitives
   ------------------------------------------------------------------ */

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 24,
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        color: disabled ? "var(--text-disabled)" : "var(--text-tertiary)",
        backgroundColor: "transparent",
        cursor: disabled ? "default" : "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseOver={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseOut={(e) => {
        if (disabled) return;
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {children}
    </button>
  );
}

function SmallIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        width: 18,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-xs)",
        color: "var(--text-tertiary)",
        backgroundColor: "transparent",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)," +
          "color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-3)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------
   Collapsed icon rail — replaces the full sidebar when collapsed.
   ------------------------------------------------------------------ */

function CollapsedRail() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        padding: "var(--space-2) 0",
        gap: 4,
        justifyItems: "center",
      }}
    >
      <IconButton
        title="Expand sidebar  ⌘B"
        onClick={() => dispatch({ type: "toggle-sidebar" })}
      >
        <IconSidebar size={16} />
      </IconButton>
      <span />
      <IconButton
        title="Settings  ⌘,"
        onClick={() => dispatch({ type: "set-settings-open", open: true })}
      >
        <IconSettings size={16} />
      </IconButton>
    </div>
  );
}
