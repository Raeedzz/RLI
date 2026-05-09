import { useState, type CSSProperties, type MouseEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  IconSidebar,
  IconBack,
  IconForward,
  IconHistory,
  IconFilter,
  IconFolderAdd,
  IconPlus,
  IconBranch,
  IconRunning,
  IconClose,
  IconHelp,
  IconSettings,
  IconChevronDown,
  IconChevronRight,
} from "@/design/icons";
import {
  useActiveProject,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import type {
  ArchiveRecord,
  Project,
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
 * Left rail. Three sections, top to bottom:
 *
 *   1. Header  — sidebar toggle + back/forward
 *   2. History — archived worktrees, click to restore
 *   3. Projects — each project + its active worktrees nested below;
 *                 hover ✕ to archive a worktree, hover + to create one
 *   4. Footer — help, settings
 *
 * Active worktree row: 2px accent strip on the left, --surface-4 fill.
 * Running-agent worktree: branch icon morphs to a 270° rotating arc.
 */
export function Sidebar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const activeProject = useActiveProject();
  const activeWorktree = useActiveWorktree();

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

      <HistorySection records={state.archivedWorktrees} dispatch={dispatch} />

      <div style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        <SectionLabel
          label="Projects"
          rightAdornment={
            <>
              <SmallIconButton title="Filter">
                <IconFilter size={14} />
              </SmallIconButton>
              <SmallIconButton
                title="Open project"
                onClick={() => void openProjectDialog(dispatch)}
              >
                <IconFolderAdd size={14} />
              </SmallIconButton>
            </>
          }
        />

        <motion.ul
          initial={false}
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {state.projectOrder.map((id, i) => {
            const project = state.projects[id];
            if (!project) return null;
            const projectWorktrees = Object.values(state.worktrees).filter(
              (w) => w.projectId === project.id,
            );
            return (
              <ProjectRow
                key={project.id}
                project={project}
                worktrees={projectWorktrees}
                index={i}
                isActive={activeProject?.id === project.id}
                activeWorktreeId={activeWorktree?.id ?? null}
              />
            );
          })}
        </motion.ul>
      </div>

      <SidebarFooter />
    </div>
  );
}

/* ------------------------------------------------------------------
   Header
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
        title="Toggle sidebar"
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

/* ------------------------------------------------------------------
   History section
   ------------------------------------------------------------------ */

function HistorySection({
  records,
  dispatch,
}: {
  records: ArchiveRecord[];
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
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
   Project row + nested worktrees
   ------------------------------------------------------------------ */

function ProjectRow({
  project,
  worktrees,
  index,
  isActive,
  activeWorktreeId,
}: {
  project: Project;
  worktrees: Worktree[];
  index: number;
  isActive: boolean;
  activeWorktreeId: string | null;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const expanded = project.expanded;
  const [hovering, setHovering] = useState(false);

  const onToggle = () =>
    dispatch({
      type: "set-project-expanded",
      id: project.id,
      expanded: !expanded,
    });

  const onSelect = () =>
    dispatch({ type: "set-active-project", id: project.id });

  const onCreateWorktree = async (e: MouseEvent) => {
    e.stopPropagation();
    const branch = window.prompt("New branch name", "");
    if (!branch) return;
    try {
      const w = await worktreeCreate(project.id, project.path, branch.trim(), branch.trim());
      dispatch({ type: "add-worktree", worktree: w });
    } catch (err) {
      toast.show({ message: `Worktree creation failed: ${err}` });
    }
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
      style={{ display: "flex", flexDirection: "column" }}
    >
      <button
        type="button"
        onClick={() => {
          onSelect();
          onToggle();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 var(--space-2)",
          paddingLeft: "var(--space-2)",
          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
          cursor: "default",
          textAlign: "left",
          width: "100%",
          backgroundColor: "transparent",
          transition: "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform var(--motion-instant) var(--ease-out-quart)",
            color: "var(--text-tertiary)",
          }}
        >
          {expanded ? (
            <IconChevronDown size={12} />
          ) : (
            <IconChevronRight size={12} />
          )}
        </span>
        <ProjectGlyph project={project} />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: "var(--weight-medium)",
          }}
        >
          {project.name}
        </span>
        {hovering && (
          <SmallIconButton title="New worktree" onClick={onCreateWorktree}>
            <IconPlus size={14} />
          </SmallIconButton>
        )}
      </button>

      <div
        style={{
          display: "grid",
          gridTemplateRows: expanded ? "1fr" : "0fr",
          transition:
            "grid-template-rows var(--motion-base) var(--ease-out-quart)",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {worktrees.map((w) => (
              <WorktreeRow
                key={w.id}
                worktree={w}
                project={project}
                isActive={activeWorktreeId === w.id}
              />
            ))}
          </ul>
        </div>
      </div>
    </motion.li>
  );
}

function ProjectGlyph({ project }: { project: Project }) {
  if (project.faviconDataUri) {
    return (
      <img
        src={project.faviconDataUri}
        alt=""
        width={14}
        height={14}
        style={{ borderRadius: 3 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: 3,
        backgroundColor: "var(--surface-3)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: 600,
        color: "var(--text-secondary)",
        flexShrink: 0,
      }}
    >
      {project.glyph}
    </span>
  );
}

function WorktreeRow({
  worktree,
  project,
  isActive,
}: {
  worktree: Worktree;
  project: Project;
  isActive: boolean;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [hovering, setHovering] = useState(false);

  const onSelect = () => {
    dispatch({ type: "set-active-project", id: project.id });
    dispatch({
      type: "set-active-worktree",
      projectId: project.id,
      worktreeId: worktree.id,
    });
  };

  const settings = useAppState().settings;
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

  const baseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 var(--space-2)",
    paddingLeft: 28,
    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
    backgroundColor: isActive ? "var(--surface-4)" : "transparent",
    boxShadow: isActive
      ? "inset 2px 0 0 0 var(--accent)"
      : "inset 2px 0 0 0 transparent",
    cursor: "default",
    textAlign: "left",
    width: "100%",
    border: "none",
    transition:
      "background-color var(--motion-instant) var(--ease-out-quart)," +
      "color var(--motion-instant) var(--ease-out-quart)," +
      "box-shadow var(--motion-fast) var(--ease-out-quart)",
  };

  const isRunning = worktree.agentStatus === "running";

  return (
    <li onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <button
        type="button"
        onClick={onSelect}
        style={baseStyle}
        onMouseOver={(e) => {
          if (!isActive)
            e.currentTarget.style.backgroundColor = "var(--surface-3)";
        }}
        onMouseOut={(e) => {
          if (!isActive)
            e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            color: isRunning ? "var(--accent)" : "var(--text-tertiary)",
            transition: "color var(--motion-fast) var(--ease-out-quart)",
          }}
        >
          {isRunning ? (
            <span className="rli-loader-spin" style={{ display: "inline-flex" }}>
              <IconRunning size={14} />
            </span>
          ) : (
            <IconBranch size={14} />
          )}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {worktree.name}
        </span>
        {worktree.changeCount > 0 && !hovering && (
          <span
            className="tabular"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--state-success)",
            }}
          >
            +{worktree.changeCount}
          </span>
        )}
        {hovering && (
          <SmallIconButton title="Archive worktree" onClick={onArchive}>
            <IconClose size={12} />
          </SmallIconButton>
        )}
      </button>
    </li>
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
   Helpers
   ------------------------------------------------------------------ */

function SectionLabel({
  label,
  rightAdornment,
}: {
  label: string;
  rightAdornment?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 28,
        padding: "0 var(--space-3) 0 var(--space-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-wide)",
      }}
    >
      <span>{label}</span>
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {rightAdornment}
      </span>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  children: React.ReactNode;
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
  children: React.ReactNode;
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

// Avoid unused-import warning when AnimatePresence isn't needed yet.
void AnimatePresence;
