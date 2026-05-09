import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  memory,
  type ClaudeMemNode,
  type ClaudeMemPayload,
  type GraphEdge,
} from "@/lib/memory";
import { useActiveProject } from "@/state/AppState";

/**
 * Obsidian-style memory graph driven by the **claude-mem** corpus.
 * Nodes are individual entries from `~/.claude-mem/chroma/` —
 * observations, session summaries, and user prompts that the
 * claude-mem MCP plugin has captured across sessions. Edges are
 * cosine-similarity links above the cutoff returned by the Rust
 * adapter (default 0.55 — MiniLM-L6 sits on a noisier floor than
 * 768-dim Gemini embeds).
 *
 * Layout is a Verlet-style force simulation — repulsion across all
 * pairs, spring attraction along edges, and a centering pull. SVG
 * render.
 *
 * Interactions:
 *   - hover    → highlight node + connected edges, show preview card
 *   - click    → pin selection, show full content card
 *   - drag     → pan the view
 *   - wheel    → zoom (cursor-anchored)
 */

interface SimNode extends ClaudeMemNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const KIND_COLOR: Record<string, string> = {
  observation: "var(--accent-bright)",
  session_summary: "var(--state-success, #6dd97a)",
  user_prompt: "var(--state-info, #6db3ff)",
  // Fallback for any future doc_type that lands without a frontend
  // mapping — the Rust adapter passes the value through verbatim.
  unknown: "var(--text-tertiary)",
};

const KIND_RADIUS: Record<string, number> = {
  observation: 5,
  session_summary: 6,
  user_prompt: 4,
  unknown: 4,
};

function colorFor(kind: string): string {
  return KIND_COLOR[kind] ?? KIND_COLOR.unknown;
}

function radiusFor(kind: string): number {
  return KIND_RADIUS[kind] ?? KIND_RADIUS.unknown;
}

// Force-sim tunables. Same values as the prior FTS-backed graph —
// they were tuned against payloads of 50–800 nodes.
const REPEL_K = 1800;
const LINK_K = 0.04;
const LINK_REST = 90;
const CENTER_K = 0.012;
const DAMPING = 0.82;
const MIN_KE = 0.05;
const MAX_DT_FRAMES = 2;

/**
 * Best-guess of which claude-mem `project` value matches the active
 * RLI project. claude-mem stores `project` as the basename of cwd
 * (e.g. `RLI`, `sckry_0.1`, `reach.sckry`). When the active RLI
 * project's path basename doesn't match anything in the corpus, we
 * fall through to "all projects" so the user always sees something.
 */
function pickDefaultProject(
  activePath: string | null | undefined,
  available: string[],
): string | null {
  if (!activePath) return null;
  const segs = activePath.split("/").filter(Boolean);
  const base = segs[segs.length - 1];
  if (!base) return null;
  if (available.includes(base)) return base;
  // Sometimes claude-mem stores `parent/child` (subworktree). Look
  // for any available project that ends with our basename.
  const suffixHit = available.find((p) => p.endsWith(`/${base}`));
  return suffixHit ?? null;
}

export function GraphView() {
  const project = useActiveProject();
  const [data, setData] = useState<ClaudeMemPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** null = all projects, "" = pending default, string = filter. */
  const [projectFilter, setProjectFilter] = useState<string | null | "">("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // ----- fetch graph -----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // First load (projectFilter === "") fetches with no filter to
    // discover `available_projects`, then we lock in a sensible
    // default before showing the graph.
    const probe = projectFilter === "";
    memory
      .claudeMemGraph(probe ? {} : { project: projectFilter ?? undefined })
      .then((p) => {
        if (cancelled) return;
        if (probe) {
          const guess = pickDefaultProject(project?.path, p.available_projects);
          if (guess && guess !== null) {
            setProjectFilter(guess);
          } else {
            setProjectFilter(null);
            setData(p);
          }
        } else {
          setData(p);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.path, projectFilter]);

  // ----- track container size for centering / viewport math -----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, r.width), h: Math.max(200, r.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ----- force simulation -----
  const simNodesRef = useRef<SimNode[]>([]);
  const adjacencyRef = useRef<Map<string, Array<{ other: string; w: number }>>>(
    new Map(),
  );
  const [, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const idleFramesRef = useRef<number>(0);

  // Rebuild simulation whenever the dataset changes. Existing node
  // positions are kept where the id matches so a refetch (e.g. user
  // added a memory) doesn't flicker the whole layout.
  useEffect(() => {
    if (!data) {
      simNodesRef.current = [];
      adjacencyRef.current = new Map();
      return;
    }
    const prev = new Map(simNodesRef.current.map((n) => [n.id, n]));
    const cx = size.w / 2;
    const cy = size.h / 2;
    simNodesRef.current = data.nodes.map((n, i) => {
      const existing = prev.get(n.id);
      if (existing) {
        return { ...n, x: existing.x, y: existing.y, vx: 0, vy: 0 };
      }
      const r = 40 + Math.sqrt(i) * 12;
      const a = i * 2.4;
      return {
        ...n,
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
        vx: 0,
        vy: 0,
      };
    });
    const adj = new Map<string, Array<{ other: string; w: number }>>();
    for (const e of data.edges) {
      if (!adj.has(e.a)) adj.set(e.a, []);
      if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a)!.push({ other: e.b, w: e.weight });
      adj.get(e.b)!.push({ other: e.a, w: e.weight });
    }
    adjacencyRef.current = adj;
    idleFramesRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const step = (ts: number) => {
      const last = lastTsRef.current || ts;
      const dtRaw = (ts - last) / 16.6667;
      const dt = Math.min(dtRaw, MAX_DT_FRAMES);
      lastTsRef.current = ts;

      const nodes = simNodesRef.current;
      const adj = adjacencyRef.current;
      const cx = size.w / 2;
      const cy = size.h / 2;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const d = Math.sqrt(d2);
          const f = REPEL_K / d2;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx * dt;
          a.vy += fy * dt;
          b.vx -= fx * dt;
          b.vy -= fy * dt;
        }
      }

      for (const a of nodes) {
        const links = adj.get(a.id);
        if (links) {
          for (const link of links) {
            const b = nodes.find((n) => n.id === link.other);
            if (!b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy + 0.01);
            const stretch = d - LINK_REST / Math.max(0.5, link.w);
            const f = LINK_K * stretch;
            a.vx += (dx / d) * f * dt;
            a.vy += (dy / d) * f * dt;
          }
        }
        a.vx += (cx - a.x) * CENTER_K * dt;
        a.vy += (cy - a.y) * CENTER_K * dt;
      }

      let ke = 0;
      for (const n of nodes) {
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        ke += n.vx * n.vx + n.vy * n.vy;
      }

      if (ke < MIN_KE) {
        idleFramesRef.current += 1;
      } else {
        idleFramesRef.current = 0;
      }

      setTick((t) => (t + 1) % 1_000_000);

      if (idleFramesRef.current < 30) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };

    if (simNodesRef.current.length > 0 && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(step);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, size.w, size.h]);

  // ----- pan + zoom -----
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(
    null,
  );
  const onMouseDown = (e: ReactMouseEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-graph-node]")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const newK = Math.min(4, Math.max(0.25, v.k * factor));
      const ratio = newK / v.k;
      return {
        k: newK,
        x: mx - (mx - v.x) * ratio,
        y: my - (my - v.y) * ratio,
      };
    });
  };

  // ----- highlight set: hovered/selected node + its 1-hop neighbors -----
  const focusId = selectedId ?? hoveredId;
  const highlight = useMemo(() => {
    if (!focusId) return null;
    const links = adjacencyRef.current.get(focusId);
    const ids = new Set<string>([focusId]);
    if (links) for (const l of links) ids.add(l.other);
    return ids;
  }, [focusId, data]);

  // ----- render -----
  const nodes = simNodesRef.current;
  const edges: GraphEdge[] = data?.edges ?? [];
  const focusedNode = focusId ? nodes.find((n) => n.id === focusId) : null;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        backgroundColor: "var(--surface-0)",
        userSelect: "none",
      }}
    >
      <Toolbar
        loading={loading}
        nodeCount={data?.nodes.length ?? 0}
        edgeCount={edges.length}
        orphans={data?.orphan_count ?? 0}
        total={data?.total ?? 0}
        availableProjects={data?.available_projects ?? []}
        projectFilter={projectFilter === "" ? null : projectFilter}
        onProjectFilter={(v) => {
          setProjectFilter(v);
          setSelectedId(null);
        }}
      />

      <svg
        width="100%"
        height="100%"
        onMouseDown={onMouseDown}
        onWheel={onWheel}
        onClick={(e) => {
          if ((e.target as Element).tagName === "svg") setSelectedId(null);
        }}
        style={{ cursor: dragRef.current ? "grabbing" : "grab", display: "block" }}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = nodes.find((n) => n.id === e.a);
            const b = nodes.find((n) => n.id === e.b);
            if (!a || !b) return null;
            const dim =
              highlight !== null && !(highlight.has(e.a) && highlight.has(e.b));
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--text-tertiary)"
                strokeOpacity={dim ? 0.05 : 0.15 + (e.weight - 0.55) * 1.2}
                strokeWidth={Math.max(0.5, (e.weight - 0.55) * 4)}
                pointerEvents="none"
              />
            );
          })}
          {nodes.map((n) => {
            const isFocus = focusId === n.id;
            const dim = highlight !== null && !highlight.has(n.id);
            return (
              <circle
                key={n.id}
                data-graph-node
                cx={n.x}
                cy={n.y}
                r={radiusFor(n.kind) + (isFocus ? 2 : 0)}
                fill={colorFor(n.kind)}
                fillOpacity={dim ? 0.2 : 1}
                stroke={isFocus ? "var(--text-primary)" : "transparent"}
                strokeWidth={1.5}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId((cur) => (cur === n.id ? null : n.id));
                }}
                style={{ cursor: "pointer" }}
              />
            );
          })}
        </g>
      </svg>

      {!loading && data && data.nodes.length === 0 && (
        <Empty>
          {data.total === 0 ? (
            <>
              no claude-mem entries for{" "}
              {projectFilter ? <code>{projectFilter}</code> : "any project"} —
              run a session with the claude-mem MCP plugin enabled to populate{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                ~/.claude-mem
              </code>
            </>
          ) : (
            <>
              {data.total} {projectFilter ? <code>{projectFilter}</code> : ""}{" "}
              entries exist, but none of the most-recent {data.orphan_count} have
              been flushed to claude-mem's HNSW index yet — its background worker
              hasn't committed them to{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>data_level0.bin</code>.
              Try again in a minute, or pick a different project to see older
              entries that are already indexed.
            </>
          )}
        </Empty>
      )}
      {error && <Empty tone="error">{error}</Empty>}
      {focusedNode && <DetailCard node={focusedNode} />}
    </div>
  );
}

function Toolbar({
  loading,
  nodeCount,
  edgeCount,
  orphans,
  total,
  availableProjects,
  projectFilter,
  onProjectFilter,
}: {
  loading: boolean;
  nodeCount: number;
  edgeCount: number;
  orphans: number;
  total: number;
  availableProjects: string[];
  projectFilter: string | null;
  onProjectFilter: (v: string | null) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        right: 8,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      <select
        value={projectFilter ?? ""}
        onChange={(e) =>
          onProjectFilter(e.target.value === "" ? null : e.target.value)
        }
        style={{
          height: 22,
          padding: "0 var(--space-2)",
          backgroundColor: "var(--surface-1)",
          color: "var(--text-secondary)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          pointerEvents: "auto",
          cursor: "pointer",
          appearance: "none",
        }}
      >
        <option value="">all projects</option>
        {availableProjects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {loading
          ? "loading…"
          : `${nodeCount} of ${total} nodes · ${edgeCount} links${orphans > 0 ? ` · ${orphans} orphans` : ""}`}
      </span>
    </div>
  );
}

function DetailCard({ node }: { node: ClaudeMemNode }) {
  return (
    <div
      style={{
        position: "absolute",
        right: 8,
        bottom: 8,
        maxWidth: 420,
        maxHeight: "60%",
        overflow: "auto",
        padding: "var(--space-3)",
        backgroundColor: "var(--surface-2)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-popover)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          marginBottom: "var(--space-1)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "var(--radius-pill)",
            backgroundColor: colorFor(node.kind),
          }}
        />
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
          {node.kind.replace(/_/g, " ")}
        </span>
        {node.project && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-disabled)",
              marginLeft: "auto",
            }}
          >
            {node.project}
          </span>
        )}
      </div>
      {node.title && (
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
            marginBottom: "var(--space-1)",
          }}
        >
          {node.title}
        </div>
      )}
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-sm)",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
        }}
      >
        {node.content}
      </div>
    </div>
  );
}

function Empty({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-6)",
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color:
          tone === "error" ? "var(--state-error-bright)" : "var(--text-tertiary)",
        pointerEvents: "none",
      }}
    >
      <div>{children}</div>
    </div>
  );
}
