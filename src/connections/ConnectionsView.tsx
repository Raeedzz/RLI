import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { connectionsViewVariants } from "@/design/motion";
import { connections, type Connection } from "@/lib/connections";
import { useActiveProject } from "@/state/AppState";

interface Props {
  onClose: () => void;
}

type Filter = "all" | "skill" | "mcp";

/**
 * Combined skills + MCPs panel (⌘⇧;).
 *
 * Slides in from the right edge, takes over the right column. v1 is
 * read-only: we list, you click → SKILL.md preview opens (deferred to
 * the editor pane wiring). MCP rows expand inline to show the command
 * line.
 *
 * Status reporting from latest Claude session log is deferred (Task
 * #13's tab summary infra hasn't been turned on for the connections
 * pane yet); rows currently show "loaded" if discovered.
 */
export function ConnectionsView({ onClose }: Props) {
  const project = useActiveProject();
  const [items, setItems] = useState<Connection[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    connections
      .scan(project?.path)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return items.filter((c) => {
      if (filter !== "all" && c.kind !== filter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q) ||
        c.command?.toLowerCase().includes(q)
      );
    });
  }, [items, filter, search]);

  const counts = useMemo(() => {
    const skills = items.filter((c) => c.kind === "skill").length;
    const mcps = items.filter((c) => c.kind === "mcp").length;
    return { skills, mcps };
  }, [items]);

  return (
    <motion.aside
      variants={connectionsViewVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 50vw)",
        backgroundColor: "var(--surface-1)",
        borderLeft: "var(--border-1)",
        boxShadow: "var(--shadow-popover)",
        zIndex: "var(--z-modal)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Header counts={counts} onClose={onClose} />
      <FilterBar
        filter={filter}
        onFilter={setFilter}
        search={search}
        onSearch={setSearch}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        {loading && <Empty label="scanning…" />}
        {error && <Empty label={`error: ${error}`} />}
        {!loading && !error && filtered.length === 0 && (
          <Empty label="no matches" />
        )}
        {filtered.map((c) => (
          <Row
            key={`${c.kind}::${c.name}::${c.path}`}
            conn={c}
            expanded={expanded === c.path}
            onToggle={() =>
              setExpanded((prev) => (prev === c.path ? null : c.path))
            }
          />
        ))}
      </div>
    </motion.aside>
  );
}

function Header({
  counts,
  onClose,
}: {
  counts: { skills: number; mcps: number };
  onClose: () => void;
}) {
  return (
    <div
      style={{
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "baseline" }}>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          connections
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
          className="tabular"
        >
          {counts.skills} skills · {counts.mcps} mcps
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        title="close (esc)"
        style={{
          width: 24,
          height: 24,
          backgroundColor: "transparent",
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-md)",
          borderRadius: "var(--radius-sm)",
          cursor: "default",
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
        ×
      </button>
    </div>
  );
}

function FilterBar({
  filter,
  onFilter,
  search,
  onSearch,
}: {
  filter: Filter;
  onFilter: (f: Filter) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  return (
    <div
      style={{
        height: "var(--filter-bar-height)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        flexShrink: 0,
      }}
    >
      <Chip active={filter === "all"} onClick={() => onFilter("all")}>
        all
      </Chip>
      <Chip active={filter === "skill"} onClick={() => onFilter("skill")}>
        skills
      </Chip>
      <Chip active={filter === "mcp"} onClick={() => onFilter("mcp")}>
        mcps
      </Chip>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="filter…"
        className="allow-select"
        style={{
          flex: 1,
          height: 22,
          padding: "0 var(--space-2)",
          backgroundColor: "var(--surface-2)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-xs)",
          color: "var(--text-primary)",
          outline: "none",
        }}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 22,
        padding: "0 var(--space-2)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        cursor: "default",
        textTransform: "lowercase",
        letterSpacing: "var(--tracking-base)",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      {children}
    </button>
  );
}

function Row({
  conn,
  expanded,
  onToggle,
}: {
  conn: Connection;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "var(--space-2) var(--space-3)",
        backgroundColor: "transparent",
        borderBottom: "var(--border-1)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--surface-2)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <KindBadge kind={conn.kind} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          {conn.name}
        </span>
        <SourceBadge source={conn.source} />
      </div>
      {conn.description && (
        <span
          style={{
            paddingLeft: 36,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: expanded ? "clip" : "ellipsis",
            whiteSpace: expanded ? "normal" : "nowrap",
            lineHeight: "var(--leading-xs)",
          }}
        >
          {conn.description}
        </span>
      )}
      {expanded && (
        <div
          style={{
            paddingLeft: 36,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {conn.command && (
            <Mono style={{ color: "var(--text-secondary)" }}>{conn.command}</Mono>
          )}
          <Mono style={{ color: "var(--text-tertiary)" }}>{conn.path}</Mono>
        </div>
      )}
    </button>
  );
}

function KindBadge({ kind }: { kind: "skill" | "mcp" }) {
  const label = kind === "skill" ? "skl" : "mcp";
  const fg = kind === "skill" ? "var(--state-info)" : "var(--state-success)";
  const bg = kind === "skill" ? "var(--state-info-bg)" : "var(--state-success-bg)";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        color: fg,
        backgroundColor: bg,
        padding: "1px 6px",
        borderRadius: "var(--radius-xs)",
        letterSpacing: "var(--tracking-base)",
      }}
    >
      {label}
    </span>
  );
}

function SourceBadge({ source }: { source: "user" | "project" | "plugin" }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        letterSpacing: "var(--tracking-base)",
      }}
    >
      {source}
    </span>
  );
}

function Mono({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontVariantLigatures: "none",
        wordBreak: "break-all",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}
