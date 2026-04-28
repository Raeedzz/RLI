import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { memory, type GraphPayload, type GraphNode, type MemoryKind } from "@/lib/memory";
import { useActiveProject, useActiveSession } from "@/state/AppState";

/**
 * Obsidian-style memory graph. Nodes are individual memory entries,
 * edges are cosine-similarity links above the threshold defined in
 * `memory.rs::GRAPH_EDGE_THRESHOLD`. Layout is a Verlet-style force
 * simulation in pure JS — repulsion across all pairs, spring
 * attraction along edges, and a centering pull. Renders in SVG.
 *
 * Interactions:
 *   - hover    → highlight node + connected edges, show preview card
 *   - click    → pin selection, show full content card
 *   - drag     → pan the view
 *   - wheel    → zoom (cursor-anchored)
 */

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const KIND_COLOR: Record<MemoryKind, string> = {
  fact: "var(--accent-bright)",
  qa: "var(--state-info, #6db3ff)",
  transcript: "var(--state-warning)",
};

const KIND_RADIUS: Record<MemoryKind, number> = {
  fact: 5,
  qa: 4,
  transcript: 6,
};

// Force-sim tunables. These were eyeballed against payloads of
// 50–500 nodes; if it ever feels sticky on small graphs or chaotic
// on large ones, the first dial to turn is REPEL_K.
const REPEL_K = 1800; // strength of node-node repulsion
const LINK_K = 0.04; // strength of edge spring
const LINK_REST = 90; // resting length of edge spring (px)
const CENTER_K = 0.012; // pull toward center
const DAMPING = 0.82;
const MIN_KE = 0.05; // total kinetic energy below which we pause
const MAX_DT_FRAMES = 2; // cap on dt to keep things stable when tab is backgrounded

export function GraphView() {
  const project = useActiveProject();
  const session = useActiveSession();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"project" | "session">("project");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Pan/zoom transform applied to the whole graph group.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // ----- fetch graph -----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const args =
      scope === "session"
        ? { projectId: project?.id, sessionId: session?.id }
        : { projectId: project?.id };
    memory
      .graph(args)
      .then((p) => {
        if (cancelled) return;
        setData(p);
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
  }, [project?.id, session?.id, scope]);

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
  // Adjacency for the spring force, by node id.
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
      // Seed new nodes on a small spiral so they don't all overlap
      // at the centre on first render.
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

  // RAF loop. Runs the force step until kinetic energy stays below
  // MIN_KE for ~30 frames, then pauses. Resumed by any interaction
  // that bumps node positions (drag, refetch, etc.).
  useEffect(() => {
    const step = (ts: number) => {
      const last = lastTsRef.current || ts;
      const dtRaw = (ts - last) / 16.6667; // normalize to ~60fps frames
      const dt = Math.min(dtRaw, MAX_DT_FRAMES);
      lastTsRef.current = ts;

      const nodes = simNodesRef.current;
      const adj = adjacencyRef.current;
      const cx = size.w / 2;
      const cy = size.h / 2;

      // Repulsion: O(N²). For our 1500-cap this is fine on a modern
      // CPU at 60fps. If we ever uncap, swap in a Barnes-Hut quadtree.
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

      // Edge spring + centering pull.
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

      // Integrate, damp, accumulate kinetic energy.
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
    // Re-arm whenever the data set or size changes — both can disturb
    // the equilibrium and we want the sim to keep running.
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
  const edges = data?.edges ?? [];
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
        scope={scope}
        onScope={setScope}
        loading={loading}
        nodeCount={data?.nodes.length ?? 0}
        edgeCount={edges.length}
        orphans={data?.orphan_count ?? 0}
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
                strokeOpacity={dim ? 0.05 : 0.15 + (e.weight - 0.65) * 1.2}
                strokeWidth={Math.max(0.5, (e.weight - 0.6) * 4)}
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
                r={KIND_RADIUS[n.kind] + (isFocus ? 2 : 0)}
                fill={KIND_COLOR[n.kind]}
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
          no memories yet — try{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            rli-memory add "first fact"
          </code>{" "}
          in any pane
        </Empty>
      )}
      {error && <Empty tone="error">{error}</Empty>}
      {focusedNode && <DetailCard node={focusedNode} />}
    </div>
  );
}

function Toolbar({
  scope,
  onScope,
  loading,
  nodeCount,
  edgeCount,
  orphans,
}: {
  scope: "project" | "session";
  onScope: (s: "project" | "session") => void;
  loading: boolean;
  nodeCount: number;
  edgeCount: number;
  orphans: number;
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
      <div
        style={{
          display: "flex",
          gap: 0,
          backgroundColor: "var(--surface-1)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          pointerEvents: "auto",
        }}
      >
        {(["project", "session"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onScope(s)}
            style={{
              height: 22,
              padding: "0 var(--space-3)",
              backgroundColor:
                scope === s ? "var(--surface-accent-tinted)" : "transparent",
              color: scope === s ? "var(--accent-bright)" : "var(--text-tertiary)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-2xs)",
              fontWeight: "var(--weight-medium)",
              letterSpacing: "var(--tracking-caps)",
              textTransform: "uppercase",
              border: "none",
              cursor: "default",
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          color: "var(--text-tertiary)",
        }}
      >
        {loading ? "loading…" : `${nodeCount} memories · ${edgeCount} links${orphans > 0 ? ` · ${orphans} orphans` : ""}`}
      </span>
    </div>
  );
}

function DetailCard({ node }: { node: GraphNode }) {
  return (
    <div
      style={{
        position: "absolute",
        right: 8,
        bottom: 8,
        maxWidth: 360,
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
            backgroundColor: KIND_COLOR[node.kind],
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
          {node.kind}
        </span>
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-sm)",
          wordBreak: "break-word",
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
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color:
          tone === "error" ? "var(--state-error-bright)" : "var(--text-tertiary)",
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
}
