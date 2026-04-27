import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backdropVariants, paletteVariants } from "@/design/motion";
import { search, type SearchHit } from "@/lib/search";
import { useActiveProject, useAppDispatch, useAppState } from "@/state/AppState";

type Mode = "text" | "regex" | "structural";

const MODE_LABELS: Record<Mode, string> = {
  text: "literal",
  regex: "regex",
  structural: "ast-grep",
};

/**
 * ⌘⇧F search overlay (Task #15).
 *
 * Three modes — text (rg literal), regex (rg regex), structural (ast-grep).
 * Tab cycles modes. Enter on a result jumps to file:line (jump-to-editor
 * wires up when the editor pane is mounted; for now we copy the path).
 *
 * Filtering is debounced 200ms so we don't spawn a new rg per keystroke.
 */
export function SearchOverlay() {
  const { searchOpen } = useAppState();
  const dispatch = useAppDispatch();
  const close = () => dispatch({ type: "set-search", open: false });

  return (
    <AnimatePresence>
      {searchOpen && (
        <motion.div
          key="search-backdrop"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: "var(--z-modal-backdrop)",
            display: "grid",
            placeItems: "start center",
            paddingTop: "min(15vh, 160px)",
          }}
        >
          <motion.div
            key="search"
            variants={paletteVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 90vw)",
              maxHeight: "70vh",
              backgroundColor: "var(--surface-2)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-modal)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              zIndex: "var(--z-modal)",
            }}
          >
            <SearchInner onClose={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SearchInner({ onClose }: { onClose: () => void }) {
  const project = useActiveProject();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("text");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (!project) return;
    if (!query.trim()) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        const hits =
          mode === "structural"
            ? await search.astGrep(project.path, query)
            : await search.rg(project.path, query, mode === "regex");
        setResults(hits);
        setCursor(0);
      } catch (e) {
        setError(String(e));
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [project, query, mode]);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) {
        // TODO: open hit.path:hit.line in editor pane.
        // For now we close — the editor wiring lives in Task #9 which
        // adds the "open file" command on session creation.
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setMode((m) =>
        m === "text" ? "regex" : m === "regex" ? "structural" : "text",
      );
    }
  };

  const placeholder = useMemo(() => {
    if (mode === "text") return "Search literal text…";
    if (mode === "regex") return "Search regex…";
    return "Search structural pattern (ast-grep)…";
  }, [mode]);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "0 var(--space-4)",
          borderBottom: "var(--border-1)",
          height: 44,
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          className="allow-select"
          style={{
            flex: 1,
            backgroundColor: "transparent",
            border: "none",
            outline: "none",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-md)",
            color: "var(--text-primary)",
          }}
        />
        <ModePill mode={mode} onCycle={() =>
          setMode((m) =>
            m === "text" ? "regex" : m === "regex" ? "structural" : "text",
          )
        }
        />
      </div>

      <div
        role="listbox"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "var(--space-1) 0",
        }}
      >
        {loading && <Hint label="searching…" />}
        {error && <Hint label={error} tone="error" />}
        {!loading && !error && query.trim() && results.length === 0 && (
          <Hint label="no matches" />
        )}
        {results.map((hit, i) => (
          <ResultRow
            key={`${hit.path}:${hit.line}:${hit.column}:${i}`}
            hit={hit}
            active={i === cursor}
            onClick={() => onClose()}
            onMouseEnter={() => setCursor(i)}
          />
        ))}
      </div>

      <Footer mode={mode} count={results.length} />
    </>
  );
}

function ModePill({ mode, onCycle }: { mode: Mode; onCycle: () => void }) {
  return (
    <button
      type="button"
      onClick={onCycle}
      title="cycle mode (Tab)"
      style={{
        height: 24,
        padding: "0 var(--space-2)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-medium)",
        color: "var(--text-secondary)",
        backgroundColor: "var(--surface-3)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-sm)",
        cursor: "default",
      }}
    >
      {MODE_LABELS[mode]}
    </button>
  );
}

function ResultRow({
  hit,
  active,
  onClick,
  onMouseEnter,
}: {
  hit: SearchHit;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        padding: "var(--space-1-5) var(--space-4)",
        backgroundColor: active ? "var(--surface-3)" : "transparent",
        cursor: "default",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
        }}
      >
        <span
          style={{
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "60%",
          }}
        >
          {hit.path}
        </span>
        <span className="tabular" style={{ color: "var(--text-tertiary)" }}>
          {hit.line}:{hit.column}
        </span>
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          fontVariantLigatures: "none",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {hit.text}
      </div>
    </div>
  );
}

function Hint({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      style={{
        padding: "var(--space-6) var(--space-4)",
        textAlign: "center",
        color:
          tone === "error" ? "var(--state-error)" : "var(--text-tertiary)",
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {label}
    </div>
  );
}

function Footer({ mode, count }: { mode: Mode; count: number }) {
  return (
    <div
      style={{
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-4)",
        borderTop: "var(--border-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        backgroundColor: "var(--surface-1)",
        userSelect: "none",
      }}
    >
      <span>
        <Mono>↑↓</Mono> navigate · <Mono>Tab</Mono> cycle mode ·{" "}
        <Mono>Enter</Mono> open · <Mono>Esc</Mono> close
      </span>
      <span className="tabular">
        {count} {count === 1 ? "match" : "matches"} · {MODE_LABELS[mode]}
      </span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </span>
  );
}
