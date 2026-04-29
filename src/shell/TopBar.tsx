import { AnimatePresence, motion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { StatusDot } from "@/primitives/StatusDot";
import { ColorPicker } from "@/primitives/ColorPicker";
import {
  LAYOUT_PROJECT_STRIP,
  LAYOUT_TAB_INDICATOR,
  projectStripSpring,
  tabIndicatorSpring,
} from "@/design/motion";
import { useArrowFocus } from "@/hooks/useArrowFocus";
import {
  useActiveProject,
  useAppDispatch,
  useAppState,
  useProjectSessions,
} from "@/state/AppState";
import { defaultWorkspaceWithEditor } from "@/state/paneTree";
import { openProjectDialog } from "@/lib/projectDialog";
import { forgetSession } from "@/terminal/sessionMemory";
import {
  tagVar,
  type Project,
  type ProjectId,
  type Session,
  type SessionId,
  type TagId,
} from "@/state/types";

const TAB_DRAG_MIME = "application/x-rli-session-tab";

/**
 * Single 28px top bar — height matches `--pane-header-height` so the
 * session tabs line up exactly with the left-panel header (files / git /
 * connections) on the same horizontal grid:
 *   [● fix oauth] [rewrite docs] [+]                     [project: RLI ▾]
 *
 * Sessions on the left as compact single-line tabs.
 * Project switcher pill flush against the window's right edge.
 *
 * Right-click any tab or the project pill → ColorPicker popover at the
 * cursor lets you tag it with one of 8 workshop-pigment colors. The
 * tag color drives the status dot, the active-indicator strip, and a
 * subtle (6%) background tint when active.
 */

type PickerTarget =
  | { type: "session"; id: SessionId }
  | { type: "project"; id: ProjectId };

interface PickerState {
  target: PickerTarget;
  anchor: { x: number; y: number };
}

export function TopBar() {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const dispatch = useAppDispatch();
  const { sessions, projects } = useAppState();
  const activeProject = useActiveProject();

  const openSessionPicker = (id: SessionId, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPicker({
      target: { type: "session", id },
      anchor: { x: e.clientX, y: e.clientY },
    });
  };

  const openProjectPicker = (id: ProjectId, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPicker({
      target: { type: "project", id },
      anchor: { x: e.clientX, y: e.clientY },
    });
  };

  const handleSelect = (color: TagId) => {
    if (!picker) return;
    const next = color === "default" ? undefined : color;
    if (picker.target.type === "session") {
      dispatch({
        type: "set-session-color",
        id: picker.target.id,
        color: next,
      });
    } else {
      dispatch({
        type: "set-project-color",
        id: picker.target.id,
        color: next,
      });
    }
  };

  const pickerSelected: TagId = (() => {
    if (!picker) return "default";
    if (picker.target.type === "session") {
      const sid = picker.target.id;
      return sessions.find((s) => s.id === sid)?.color ?? "default";
    }
    const pid = picker.target.id;
    return projects.find((p) => p.id === pid)?.color ?? "default";
  })();

  return (
    <>
      <header
        // Tauri turns any element with this attribute into a window drag
        // region. Children that are <button>s or have explicit
        // data-tauri-drag-region="false" stay clickable.
        data-tauri-drag-region
        style={{
          minHeight: "var(--pane-header-height)",
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-start",
          backgroundColor: "var(--surface-1)",
          borderBottom: "var(--border-1)",
          // Tabs sit flush against both column edges — the workspace
          // below has zero gutter, so any top-bar padding would
          // misalign tabs with the pane below them.
          paddingLeft: 0,
          paddingRight: 0,
          userSelect: "none",
        }}
      >
        <SessionTabs onSessionContextMenu={openSessionPicker} />
        {activeProject && (
          <ProjectSwitcher
            onContextMenu={(e) => openProjectPicker(activeProject.id, e)}
          />
        )}
      </header>

      <AnimatePresence>
        {picker && (
          <ColorPicker
            anchor={picker.anchor}
            selected={pickerSelected}
            onSelect={handleSelect}
            onClose={() => setPicker(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------
   Session tabs (left side of top bar)
   ------------------------------------------------------------------ */

function SessionTabs({
  onSessionContextMenu,
}: {
  onSessionContextMenu: (id: SessionId, e: ReactMouseEvent) => void;
}) {
  const project = useActiveProject();
  const sessions = useProjectSessions(project?.id ?? null);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const activeId = project ? state.activeSessionByProject[project.id] : null;
  const [editingId, setEditingId] = useState<SessionId | null>(null);
  const [dropTargetId, setDropTargetId] = useState<SessionId | null>(null);
  const onArrowKey = useArrowFocus("horizontal");

  if (!project) return <div />;

  const onTabDragStart = (id: SessionId) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TAB_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onTabDragOver = (id: SessionId) => (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropTargetId !== id) setDropTargetId(id);
    }
  };
  const onTabDragLeave = () => setDropTargetId(null);
  const onTabDrop = (targetId: SessionId) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropTargetId(null);
    const sourceId = e.dataTransfer.getData(TAB_DRAG_MIME) as SessionId;
    if (!sourceId || sourceId === targetId) return;
    const ids = sessions.map((s) => s.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    dispatch({ type: "reorder-sessions", projectId: project.id, ids });
  };

  return (
    <div
      role="tablist"
      aria-label="Sessions"
      aria-orientation="horizontal"
      // Tauri 2's drag-region check looks only at e.target — it doesn't
      // walk up the DOM. So even though the parent <header> is a drag
      // region, this flex:1 row would swallow clicks in the empty space
      // after the tabs and block window dragging. Mark it explicitly so
      // the gap right of the tabs (and right of "+") drags the window.
      data-tauri-drag-region
      onKeyDown={onArrowKey}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        flexWrap: "wrap",
        rowGap: 2,
        minWidth: 0,
        flex: 1,
      }}
    >
      {sessions.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          active={session.id === activeId}
          editing={editingId === session.id}
          dropTarget={dropTargetId === session.id}
          onSelect={() =>
            dispatch({
              type: "set-active-session",
              projectId: project.id,
              sessionId: session.id,
            })
          }
          onClose={() => {
            forgetSession(session.id);
            dispatch({ type: "remove-session", id: session.id });
          }}
          onContextMenu={(e) => onSessionContextMenu(session.id, e)}
          onStartRename={() => setEditingId(session.id)}
          onCommitRename={(name) => {
            const trimmed = name.trim();
            if (trimmed) {
              dispatch({
                type: "update-session",
                id: session.id,
                patch: { name: trimmed },
              });
            }
            setEditingId(null);
          }}
          onCancelRename={() => setEditingId(null)}
          onDragStart={onTabDragStart(session.id)}
          onDragOver={onTabDragOver(session.id)}
          onDragLeave={onTabDragLeave}
          onDrop={onTabDrop(session.id)}
        />
      ))}
      <NewSessionButton projectId={project.id} />
    </div>
  );
}

function SessionTab({
  session,
  active,
  editing,
  dropTarget,
  onSelect,
  onClose,
  onContextMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  session: Session;
  active: boolean;
  editing: boolean;
  dropTarget: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const tagColor = tagVar(session.color);
  const activeBg = `color-mix(in oklch, var(--surface-2), ${tagColor} 6%)`;
  const hoverBg = `color-mix(in oklch, var(--surface-1), ${tagColor} 4%)`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftName, setDraftName] = useState(session.name);

  useEffect(() => {
    if (editing) {
      setDraftName(session.name);
      // Focus + select on next tick — input must be mounted first.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, session.name]);

  return (
    <div
      role="tab"
      aria-selected={active}
      // Roving tabindex: only the active tab is in the document tab
      // order, so Tab moves out of the tablist (into the next widget)
      // instead of cycling through every session. ←/→ via the
      // useArrowFocus hook on the parent moves focus between tabs.
      tabIndex={editing ? -1 : active ? 0 : -1}
      data-tauri-drag-region={false}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={editing ? undefined : onSelect}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStartRename();
      }}
      onContextMenu={onContextMenu}
      title={session.subtitle}
      style={{
        position: "relative",
        flexShrink: 0,
        minWidth: 0,
        maxWidth: 220,
        height: "var(--pane-header-height)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        backgroundColor: dropTarget
          ? "var(--surface-accent-tinted)"
          : active
            ? activeBg
            : "transparent",
        borderRight: "var(--border-1)",
        boxShadow: dropTarget
          ? "inset 2px 0 0 0 var(--accent-bright)"
          : "none",
        cursor: editing ? "text" : "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active && !dropTarget)
          e.currentTarget.style.backgroundColor = hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!active && !dropTarget)
          e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {active && (
        <motion.span
          layoutId={LAYOUT_TAB_INDICATOR}
          transition={tabIndicatorSpring}
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: tagColor,
          }}
        />
      )}

      <StatusDot
        status={session.status}
        color={session.color ? tagColor : undefined}
      />

      {editing ? (
        <input
          ref={inputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename(draftName);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={() => onCommitRename(draftName)}
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            backgroundColor: "var(--surface-2)",
            border: "1px solid var(--accent-bright)",
            borderRadius: "var(--radius-xs)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            padding: "2px var(--space-2)",
            outline: "none",
            letterSpacing: "var(--tracking-tight)",
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: active
              ? "var(--weight-medium)"
              : "var(--weight-regular)",
            color: active ? "var(--text-primary)" : "var(--text-secondary)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          {session.name}
        </span>
      )}

      {!editing && (
        <span
          role="button"
          aria-label="close session"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            width: 16,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--text-tertiary)",
            opacity: active ? 0.6 : 0,
            borderRadius: "var(--radius-xs)",
            transition: "opacity var(--motion-instant) var(--ease-out-quart)",
          }}
        >
          ×
        </span>
      )}
    </div>
  );
}

function NewSessionButton({ projectId }: { projectId: ProjectId }) {
  const dispatch = useAppDispatch();
  const sessions = useProjectSessions(projectId);

  const onClick = () => {
    const n = sessions.length + 1;
    const id = `s_${Date.now().toString(36)}`;
    dispatch({
      type: "add-session",
      session: {
        id,
        projectId,
        name: `session ${n}`,
        subtitle: "ready",
        branch: `rli/session-${n}`,
        status: "idle",
        createdAt: Date.now(),
        workspace: defaultWorkspaceWithEditor(),
        openFile: null,
      },
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="new session  ⌘N"
      aria-label="new session"
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: "var(--pane-header-height)",
        backgroundColor: "transparent",
        color: "var(--text-tertiary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-md)",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart), color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-2)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      +
    </button>
  );
}

/* ------------------------------------------------------------------
   Project switcher (right side of top bar — flush against window edge)
   ------------------------------------------------------------------ */

function ProjectSwitcher({
  onContextMenu,
}: {
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const project = useActiveProject();
  const { projects } = useAppState();
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);

  if (!project) return null;

  const tagColor = tagVar(project.color);
  const tinted = `color-mix(in oklch, var(--surface-2), ${tagColor} 6%)`;
  const tintedHover = `color-mix(in oklch, var(--surface-3), ${tagColor} 8%)`;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={onContextMenu}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: "var(--pane-header-height)",
          gap: "var(--space-2)",
          padding: "0 var(--space-3) 0 var(--space-3)",
          backgroundColor: open ? tintedHover : tinted,
          color: "var(--text-primary)",
          borderLeft: "var(--border-1)",
          // Anchored to the window edge — no right border, no right radius
          borderRight: "none",
          borderTop: "none",
          borderBottom: "none",
          borderTopLeftRadius: "var(--radius-sm)",
          borderBottomLeftRadius: "var(--radius-sm)",
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
          cursor: "default",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.backgroundColor = tintedHover;
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.backgroundColor = tinted;
        }}
      >
        {project.color && (
          <StatusDot status="idle" color={tagColor} />
        )}
        <span
          style={{
            color: "var(--text-tertiary)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-regular)",
            letterSpacing: "var(--tracking-base)",
          }}
        >
          project
        </span>
        <span>{project.name}</span>
        <span
          style={{
            color: "var(--text-tertiary)",
            fontSize: "var(--text-2xs)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition:
              "transform var(--motion-fast) var(--ease-out-quart)",
          }}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            minWidth: 260,
            backgroundColor: "var(--surface-3)",
            borderTopLeftRadius: "var(--radius-md)",
            borderBottomLeftRadius: "var(--radius-md)",
            borderBottomRightRadius: "var(--radius-md)",
            // top-right corner stays sharp so the menu reads as anchored
            // to the pill above
            borderTopRightRadius: 0,
            boxShadow: "var(--shadow-popover)",
            zIndex: "var(--z-dropdown)",
            padding: "var(--space-1) 0",
          }}
        >
          {projects.map((p) => (
            <ProjectMenuItem
              key={p.id}
              project={p}
              active={p.id === project.id}
              onSelect={() => {
                dispatch({ type: "set-active-project", id: p.id });
                setOpen(false);
              }}
            />
          ))}
          <div
            style={{
              borderTop: "var(--border-1)",
              marginTop: 4,
              paddingTop: 4,
            }}
          >
            <ProjectMenuItem
              project={null}
              active={false}
              label="open project…"
              keys="⌘O"
              onSelect={() => {
                setOpen(false);
                void openProjectDialog(dispatch);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectMenuItem({
  project,
  active,
  onSelect,
  label,
  keys,
}: {
  project: Project | null;
  active: boolean;
  onSelect: () => void;
  label?: string;
  keys?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        height: 28,
        padding: "0 var(--space-3)",
        backgroundColor: "transparent",
        cursor: "default",
        position: "relative",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--surface-4)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      {active && project ? (
        <motion.span
          layoutId={LAYOUT_PROJECT_STRIP}
          transition={projectStripSpring}
          style={{
            width: 2,
            height: 14,
            backgroundColor: tagVar(project.color),
            borderRadius: "var(--radius-pill)",
            flexShrink: 0,
          }}
        />
      ) : (
        <span style={{ width: 2, flexShrink: 0 }} />
      )}

      {project?.color && (
        <StatusDot status="idle" color={tagVar(project.color)} />
      )}

      <span
        style={{
          flex: 1,
          textAlign: "left",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          fontWeight: active
            ? "var(--weight-medium)"
            : "var(--weight-regular)",
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label ?? project?.name}
      </span>
      {project && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {abbreviatePath(project.path)}
        </span>
      )}
      {keys && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {keys}
        </span>
      )}
    </button>
  );
}

function abbreviatePath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

