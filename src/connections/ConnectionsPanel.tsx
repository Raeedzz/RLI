import { useEffect, useMemo, useState } from "react";
import { connections, type Connection } from "@/lib/connections";

interface Props {
  projectPath?: string;
}

type Filter = "all" | "skill" | "mcp";

/**
 * Left-rail edition of the skills + MCPs panel. No overlay framing,
 * no internal close button — visibility is owned by the AppShell's
 * leftPanel state and dismissed via the ActivityRail toggle.
 */
export function ConnectionsPanel({ projectPath }: Props) {
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
      .scan(projectPath)
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
  }, [projectPath]);

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
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-1)",
        minHeight: 0,
      }}
    >
      <Header counts={counts} />
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
    </div>
  );
}

function Header({
  counts,
}: {
  counts: { skills: number; mcps: number };
}) {
  return (
    <div
      style={{
        height: "var(--pane-header-height)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        borderBottom: "var(--border-1)",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        skills · mcps
      </span>
      <span
        className="tabular"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {counts.skills} skl · {counts.mcps} mcp
      </span>
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
        skl
      </Chip>
      <Chip active={filter === "mcp"} onClick={() => onFilter("mcp")}>
        mcp
      </Chip>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="filter…"
        className="allow-select"
        style={{
          flex: 1,
          minWidth: 0,
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
        cursor: "pointer",
        textTransform: "lowercase",
        letterSpacing: "var(--tracking-base)",
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
        cursor: "pointer",
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
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {conn.name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
          }}
        >
          {conn.source}
        </span>
      </div>
      {conn.description && (
        <span
          style={{
            paddingLeft: 30,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-2xs)",
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
            paddingLeft: 30,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {conn.command && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                color: "var(--text-secondary)",
                wordBreak: "break-all",
              }}
            >
              {conn.command}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              wordBreak: "break-all",
            }}
          >
            {conn.path}
          </span>
        </div>
      )}
    </button>
  );
}

function KindBadge({ kind }: { kind: "skill" | "mcp" }) {
  const label = kind === "skill" ? "skl" : "mcp";
  const fg = kind === "skill" ? "var(--state-info)" : "var(--state-success)";
  const bg =
    kind === "skill" ? "var(--state-info-bg)" : "var(--state-success-bg)";
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
      }}
    >
      {label}
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
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}
