import {
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { IconPickerDialog } from "@/shell/IconPickerDialog";
import { ContextMenu, type ContextMenuItem } from "@/shell/ContextMenu";
import { lookupPickerIcon } from "@/design/picker-icons";
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
  IconEdit,
} from "@/design/icons";
import { Image01Icon, Link01Icon, ViewOffIcon, Delete01Icon } from "hugeicons-react";
import {
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
  nextAutoBranch,
  worktreeArchive,
  primaryTerminalTab,
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

  const projectIds = state.projectOrder.length
    ? state.projectOrder
    : Object.keys(state.projects);

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
        }}
      >
        <ProjectsHeader />
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: "0 var(--space-1) var(--space-2)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {projectIds.map((id) => {
            const project = state.projects[id];
            if (!project) return null;
            const projectWorktrees = Object.values(state.worktrees).filter(
              (w) => w.projectId === id,
            );
            return (
              <ProjectGroup
                key={id}
                project={project}
                worktrees={projectWorktrees}
                activeWorktreeId={activeWorktree?.id ?? null}
              />
            );
          })}
          {projectIds.length === 0 && (
            <li
              style={{
                padding: "var(--space-3)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-xs)",
              }}
            >
              No projects yet — press ⌘O to open a folder.
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

function ProjectsHeader() {
  const dispatch = useAppDispatch();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 30,
        padding: "0 var(--space-2) 0 var(--space-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-xs)",
        letterSpacing: "var(--tracking-wide)",
      }}
    >
      <span>Projects</span>
      <span style={{ flex: 1 }} />
      <SmallIconButton title="Filter">
        <IconFilter size={14} />
      </SmallIconButton>
      <SmallIconButton
        title="Open project (⌘O)"
        onClick={() => void openProjectDialog(dispatch)}
      >
        <IconFolderAdd size={14} />
      </SmallIconButton>
    </div>
  );
}

/* ------------------------------------------------------------------
   Project group: header (glyph + name + add) + worktree rows
   ------------------------------------------------------------------ */

function ProjectGroup({
  project,
  worktrees,
  activeWorktreeId,
}: {
  project: Project;
  worktrees: Worktree[];
  activeWorktreeId: string | null;
}) {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [hovering, setHovering] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );

  const state = useAppState();
  const onCreate = async () => {
    const branch = nextAutoBranch(project.id, state);
    try {
      const w = await worktreeCreate(
        project.id,
        project.path,
        branch,
        branch,
      );
      dispatch({ type: "add-worktree", worktree: w });
      // Auto-open the primary terminal so the new agent lands in a
      // live shell instead of an empty main column.
      dispatch({ type: "open-tab", tab: primaryTerminalTab(w) });
    } catch (err) {
      toast.show({ message: `Worktree creation failed: ${err}` });
    }
  };

  const projectMenuItems: ContextMenuItem[] = [
    {
      id: "new-worktree",
      label: "New workspace",
      Glyph: IconPlus,
      shortcut: "⌘N",
      onSelect: () => void onCreate(),
    },
    {
      id: "create-from",
      label: "Create from…",
      Glyph: Link01Icon,
      shortcut: "⌘⇧N",
      onSelect: () => {
        // TODO: open a "create from branch" dialog. For now, behave
        // like New workspace but explicitly mark it as the same flow.
        void onCreate();
      },
    },
    {
      id: "settings",
      label: "Repository settings",
      Glyph: IconSettings,
      shortcut: "⌘,",
      onSelect: () => dispatch({ type: "set-settings-open", open: true }),
    },
    {
      id: "change-icon",
      label: "Change icon",
      Glyph: Image01Icon,
      onSelect: () => setPickerOpen(true),
    },
    {
      id: "hide",
      label: "Hide repository",
      Glyph: ViewOffIcon,
      onSelect: () =>
        dispatch({
          type: "set-project-expanded",
          id: project.id,
          expanded: false,
        }),
    },
    {
      id: "remove",
      label: "Remove repository",
      Glyph: Delete01Icon,
      destructive: true,
      onSelect: () => {
        if (
          window.confirm(
            `Remove ${project.name} from the sidebar? Local files are untouched.`,
          )
        ) {
          dispatch({ type: "remove-project", id: project.id });
        }
      },
    },
  ];

  return (
    <li
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={(e) => {
          // Ignore double-clicks landing on the +new-worktree button.
          const t = e.target as HTMLElement;
          if (t.closest("button")) return;
          e.preventDefault();
          setPickerOpen(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 38,
          padding: "0 var(--space-2)",
          color: "var(--text-primary)",
          fontSize: "var(--text-base)",
          fontWeight: "var(--weight-semibold)",
          cursor: "default",
          userSelect: "none",
        }}
      >
        <ProjectGlyph project={project} />
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.name}
        </span>
        {hovering && (
          <SmallIconButton title="New worktree" onClick={onCreate}>
            <IconPlus size={14} />
          </SmallIconButton>
        )}
      </div>

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

      <IconPickerDialog
        open={pickerOpen}
        targetName={project.name}
        currentIcon={project.iconName}
        currentColor={project.color}
        onSelectIcon={(name) =>
          dispatch({
            type: "set-project-icon",
            id: project.id,
            iconName: name,
          })
        }
        onSelectColor={(c) =>
          dispatch({
            type: "set-project-color",
            id: project.id,
            color: c,
          })
        }
        onRename={(newName) =>
          dispatch({
            type: "update-project",
            id: project.id,
            patch: { name: newName },
          })
        }
        onClose={() => setPickerOpen(false)}
      />

      <ContextMenu
        open={!!menuAnchor}
        anchor={menuAnchor}
        items={projectMenuItems}
        onClose={() => setMenuAnchor(null)}
      />
    </li>
  );
}

function ProjectGlyph({ project }: { project: Project }) {
  // Precedence: user-picked HugeIcon → favicon scanned at project add
  // → first-letter glyph fallback. The HugeIcon path is the user's
  // explicit override; the favicon path is best-effort auto-detection
  // (populated by the backend at scan time, may be null).
  const iconEntry = lookupPickerIcon(project.iconName);
  if (iconEntry) {
    const Glyph = iconEntry.Component;
    return (
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: project.color
            ? `var(--tag-${project.color})`
            : "var(--text-secondary)",
          flexShrink: 0,
        }}
      >
        <Glyph size={18} />
      </span>
    );
  }
  if (project.faviconDataUri) {
    return (
      <img
        src={project.faviconDataUri}
        alt=""
        width={20}
        height={20}
        style={{ borderRadius: 4, flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        backgroundColor: project.color
          ? `color-mix(in oklch, var(--surface-3), var(--tag-${project.color}) 35%)`
          : "var(--surface-3)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-primary)",
        flexShrink: 0,
      }}
    >
      {project.glyph}
    </span>
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
   Worktree row — compact, indented under its project header.
   ------------------------------------------------------------------ */

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
  const settings = useAppState().settings;
  const toast = useToast();
  const [hovering, setHovering] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  const isRunning = worktree.agentStatus === "running";

  const onSelect = () => {
    dispatch({ type: "set-active-project", id: project.id });
    dispatch({
      type: "set-active-worktree",
      projectId: project.id,
      worktreeId: worktree.id,
    });
  };

  const onDoubleClick = (e: MouseEvent) => {
    // Ignore double-clicks landing on inner buttons (archive ✕, etc.)
    const t = e.target as HTMLElement;
    if (t.closest("button") && t.closest("button") !== e.currentTarget) return;
    e.preventDefault();
    setPickerOpen(true);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuAnchor({ x: e.clientX, y: e.clientY });
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

  // Idle: transparent. Active: surface-3 fill. Hover: surface-2.
  // When colored, blend the tag in subtly so the row reads tinted but
  // doesn't fight the rest of the chrome.
  const colored = !!worktree.color;
  const restingBg = colored
    ? `color-mix(in oklch, transparent, var(--tag-${worktree.color}) 25%)`
    : "transparent";
  const hoverBg = colored
    ? `color-mix(in oklch, var(--surface-2), var(--tag-${worktree.color}) 35%)`
    : "var(--surface-2)";
  const activeBg = colored
    ? `color-mix(in oklch, var(--surface-3), var(--tag-${worktree.color}) 35%)`
    : "var(--surface-3)";
  const startBg = isActive ? activeBg : restingBg;
  const textColor = isActive ? "var(--text-primary)" : "var(--text-secondary)";

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 34,
    padding: "0 var(--space-2) 0 32px",
    borderRadius: "var(--radius-sm)",
    backgroundColor: startBg,
    color: textColor,
    fontSize: "var(--text-base)",
    textAlign: "left",
    border: "none",
    cursor: "default",
    transition:
      "background-color var(--motion-instant) var(--ease-out-quart)," +
      "color var(--motion-instant) var(--ease-out-quart)",
  };

  // Glyph precedence: user-picked HugeIcon → running spinner → branch.
  const iconEntry = lookupPickerIcon(worktree.iconName);

  return (
    <li
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        style={rowStyle}
        onMouseOver={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = hoverBg;
        }}
        onMouseOut={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = restingBg;
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            color: isRunning
              ? "var(--accent)"
              : iconEntry
                ? worktree.color
                  ? `var(--tag-${worktree.color})`
                  : "var(--text-secondary)"
                : "var(--text-tertiary)",
            transition: "color var(--motion-fast) var(--ease-out-quart)",
            flexShrink: 0,
          }}
        >
          {isRunning ? (
            <span
              key="running"
              className="rli-loader-spin"
              style={{ display: "inline-flex" }}
            >
              <IconRunning size={16} />
            </span>
          ) : iconEntry ? (
            <iconEntry.Component size={16} />
          ) : (
            <IconBranch key="idle" size={16} />
          )}
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {worktree.name}
        </span>

        {hovering ? (
          <SmallIconButton title="Archive worktree" onClick={onArchive}>
            <IconClose size={12} />
          </SmallIconButton>
        ) : worktree.changeCount > 0 ? (
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
        ) : null}
      </button>

      <IconPickerDialog
        open={pickerOpen}
        targetName={worktree.name}
        currentIcon={worktree.iconName}
        currentColor={worktree.color}
        onSelectIcon={(name) =>
          dispatch({
            type: "set-worktree-icon",
            worktreeId: worktree.id,
            iconName: name,
          })
        }
        onSelectColor={(c) =>
          dispatch({
            type: "update-worktree",
            id: worktree.id,
            patch: { color: c },
          })
        }
        onRename={(newName) =>
          dispatch({
            type: "update-worktree",
            id: worktree.id,
            patch: { name: newName },
          })
        }
        onClose={() => setPickerOpen(false)}
      />

      <ContextMenu
        open={!!menuAnchor}
        anchor={menuAnchor}
        items={[
          {
            id: "rename",
            label: "Rename worktree",
            Glyph: IconEdit,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "icon",
            label: "Change icon",
            Glyph: Image01Icon,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "color",
            label: "Change color",
            Glyph: Link01Icon,
            onSelect: () => setPickerOpen(true),
          },
          {
            id: "archive",
            label: "Archive worktree",
            Glyph: Delete01Icon,
            destructive: true,
            onSelect: () => {
              const e = {
                stopPropagation: () => undefined,
              } as unknown as MouseEvent;
              void onArchive(e);
            },
          },
        ]}
        onClose={() => setMenuAnchor(null)}
      />
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
