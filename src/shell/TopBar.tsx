import { motion } from "motion/react";
import { useState } from "react";
import { StatusDot } from "@/primitives/StatusDot";
import {
  LAYOUT_PROJECT_STRIP,
  LAYOUT_TAB_INDICATOR,
  projectStripSpring,
  tabIndicatorSpring,
} from "@/design/motion";
import {
  useActiveProject,
  useAppDispatch,
  useAppState,
  useProjectSessions,
} from "@/state/AppState";
import type { Project, Session } from "@/state/types";

/**
 * Single 36px top bar:
 *   [● fix oauth] [rewrite docs] [+]                     project: RLI ▾
 *
 * Sessions on the left as compact single-line tabs (status dot + name).
 * Project switcher on the right as a click-to-toggle dropdown.
 * Active session indicator slides between tabs via shared `layoutId`.
 */
export function TopBar() {
  return (
    <header
      style={{
        height: 36,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-between",
        backgroundColor: "var(--surface-1)",
        borderBottom: "var(--border-1)",
        paddingRight: "var(--space-3)",
        // macOS overlay-titlebar leaves a 78px gap on the left for the traffic lights
        paddingLeft: 78,
        userSelect: "none",
      }}
    >
      <SessionTabs />
      <ProjectSwitcher />
    </header>
  );
}

/* ------------------------------------------------------------------
   Session tabs (left side of top bar)
   ------------------------------------------------------------------ */

function SessionTabs() {
  const project = useActiveProject();
  const sessions = useProjectSessions(project?.id ?? null);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const activeId = project ? state.activeSessionByProject[project.id] : null;

  if (!project) return <div />;

  return (
    <div
      role="tablist"
      aria-label="Sessions"
      style={{
        display: "flex",
        alignItems: "stretch",
        minWidth: 0,
        flex: 1,
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {sessions.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          active={session.id === activeId}
          onSelect={() =>
            dispatch({
              type: "set-active-session",
              projectId: project.id,
              sessionId: session.id,
            })
          }
          onClose={() => dispatch({ type: "remove-session", id: session.id })}
        />
      ))}
      <NewSessionButton />
    </div>
  );
}

function SessionTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      title={session.subtitle}
      style={{
        position: "relative",
        flexShrink: 0,
        minWidth: 0,
        maxWidth: 220,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        backgroundColor: active ? "var(--surface-2)" : "transparent",
        borderRight: "var(--border-1)",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active)
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!active)
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
            backgroundColor: "var(--accent)",
          }}
        />
      )}

      <StatusDot status={session.status} />

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
    </button>
  );
}

function NewSessionButton() {
  return (
    <button
      type="button"
      title="new session  ⌘N"
      aria-label="new session"
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
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
   Project switcher (right side of top bar)
   ------------------------------------------------------------------ */

function ProjectSwitcher() {
  const project = useActiveProject();
  const { projects } = useAppState();
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);

  if (!project) return null;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2)",
          height: 24,
          padding: "0 var(--space-3)",
          backgroundColor: open ? "var(--surface-3)" : "var(--surface-2)",
          color: "var(--text-primary)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
          cursor: "default",
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)",
        }}
      >
        <span
          style={{
            color: "var(--text-tertiary)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-regular)",
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
            transition: "transform var(--motion-fast) var(--ease-out-quart)",
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
            top: 32,
            right: 0,
            minWidth: 240,
            backgroundColor: "var(--surface-3)",
            borderRadius: "var(--radius-md)",
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
              onSelect={() => setOpen(false)}
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
      {active && project && (
        <motion.span
          layoutId={LAYOUT_PROJECT_STRIP}
          transition={projectStripSpring}
          style={{
            width: 2,
            height: 14,
            backgroundColor: "var(--accent)",
            borderRadius: "var(--radius-pill)",
            flexShrink: 0,
          }}
        />
      )}
      {!active && <span style={{ width: 2, flexShrink: 0 }} />}

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
