import { AnimatePresence } from "motion/react";
import { useState, type DragEvent, type ReactNode } from "react";
import { SplitChooser } from "./SplitChooser";
import { useAppDispatch, useAppState } from "@/state/AppState";
import type { PaneContent, PaneNodeId, SplitDirection } from "@/state/types";

interface Props {
  paneId: PaneNodeId;
  content: PaneContent;
  /** True when this is the only pane in the tree — close button is hidden. */
  isOnly: boolean;
  /**
   * Optional contextual line shown after the content type in the header.
   * For terminals, this is the live session subtitle (the AI-generated
   * "what's happening" summary); for editors, the open file's basename.
   */
  subtitle?: string;
  children: ReactNode;
}

const HEADER_HEIGHT = 28;
const DRAG_MIME = "application/x-rli-pane";

const CONTENT_LABEL: Record<PaneContent, string> = {
  terminal: "terminal",
  editor: "editor",
  browser: "browser",
};

/**
 * Chrome wrapper around a leaf pane. Renders the pane's body (Terminal /
 * Editor / Browser) below a 28px header that lets the user split, change
 * content, or close the pane. The header is also a drag handle — drop it
 * onto another pane to swap them.
 */
export function PaneFrame({
  paneId,
  content,
  isOnly,
  subtitle,
  children,
}: Props) {
  const dispatch = useAppDispatch();
  const [chooser, setChooser] = useState<{
    anchor: { x: number; y: number };
    mode: "split" | "replace";
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { workspace } = useAppState();

  const onSplit = (direction: SplitDirection, newContent: PaneContent) => {
    dispatch({ type: "split-pane", paneId, direction, content: newContent });
    setChooser(null);
  };

  const onReplace = (newContent: PaneContent) => {
    dispatch({ type: "set-pane-content", paneId, content: newContent });
    setChooser(null);
  };

  const openSplit = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setChooser({
      anchor: { x: rect.right - 4, y: rect.bottom + 4 },
      mode: "split",
    });
  };

  const openReplace = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setChooser({
      anchor: { x: rect.left, y: rect.bottom + 4 },
      mode: "replace",
    });
  };

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(DRAG_MIME, paneId);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragOver) setDragOver(true);
    }
  };

  const onDragLeave = () => setDragOver(false);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const sourceId = e.dataTransfer.getData(DRAG_MIME);
    if (sourceId && sourceId !== paneId) {
      dispatch({ type: "swap-panes", aId: sourceId, bId: paneId });
    }
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: "relative",
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-0)",
        overflow: "hidden",
        // Each pane reads as its own card. The workspace wrapper paints
        // surface-1 in the gaps so panes "float". Outline-only highlight
        // on drag-over so it never displaces layout.
        borderRadius: "var(--radius-md)",
        outline: dragOver ? "2px solid var(--accent-bright)" : "none",
        outlineOffset: -2,
        transition:
          "outline-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <div
        draggable
        onDragStart={onDragStart}
        style={{
          height: HEADER_HEIGHT,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          paddingLeft: "var(--space-3)",
          paddingRight: "var(--space-1)",
          backgroundColor: "var(--surface-1)",
          borderBottom: "var(--border-1)",
          borderTopLeftRadius: "var(--radius-md)",
          borderTopRightRadius: "var(--radius-md)",
          cursor: "grab",
          gap: "var(--space-2)",
          minWidth: 0,
        }}
      >
        <button
          type="button"
          onClick={openReplace}
          title="Change content type"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1-5)",
            height: 22,
            padding: "0 var(--space-2)",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "transparent",
            color: "var(--text-secondary)",
            fontSize: "var(--text-2xs)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-caps)",
            fontWeight: "var(--weight-semibold)",
            cursor: "default",
            flexShrink: 0,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--surface-2)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "transparent")
          }
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-pill)",
              backgroundColor: contentDot(content),
            }}
          />
          {CONTENT_LABEL[content]}
          <span
            aria-hidden
            style={{
              fontSize: 9,
              color: "var(--text-tertiary)",
              marginLeft: 2,
            }}
          >
            ▾
          </span>
        </button>

        {subtitle && subtitle.trim() !== "" && (
          <>
            <span
              aria-hidden
              style={{
                color: "var(--text-disabled)",
                fontSize: "var(--text-2xs)",
                flexShrink: 0,
              }}
            >
              ·
            </span>
            <span
              title={subtitle}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-xs)",
                fontStyle: "italic",
                color: "var(--text-secondary)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {subtitle}
            </span>
          </>
        )}

        {(!subtitle || subtitle.trim() === "") && (
          <span style={{ flex: 1 }} />
        )}

        <button
          type="button"
          onClick={openSplit}
          title="Split this pane"
          aria-label="Split this pane"
          style={{
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-tertiary)",
            cursor: "default",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--surface-2)";
            e.currentTarget.style.color = "var(--accent-bright)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
        >
          <SplitGlyph />
        </button>

        {!isOnly && (
          <button
            type="button"
            onClick={() => dispatch({ type: "close-pane", paneId })}
            title="Close pane"
            aria-label="Close pane"
            style={{
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              cursor: "default",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor =
                "var(--surface-error-soft)";
              e.currentTarget.style.color = "var(--state-error-bright)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--text-tertiary)";
            }}
          >
            ×
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {children}
        {dragOver && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor:
                "color-mix(in oklch, transparent, var(--accent-bright) 12%)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      <AnimatePresence>
        {chooser && (
          <SplitChooser
            mode={chooser.mode}
            anchor={chooser.anchor}
            currentContent={content}
            onSplit={onSplit}
            onReplace={onReplace}
            onClose={() => setChooser(null)}
            workspaceLeafCount={leafCount(workspace)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function contentDot(content: PaneContent): string {
  if (content === "terminal") return "var(--state-success)";
  if (content === "editor") return "var(--accent-bright)";
  return "var(--state-warning)";
}

function leafCount(node: import("@/state/types").PaneNode): number {
  if (node.kind === "leaf") return 1;
  return leafCount(node.children[0]) + leafCount(node.children[1]);
}

function SplitGlyph() {
  // A 14×14 glyph showing two squares side-by-side — the universal
  // "split" icon in modern terminals.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect
        x="1"
        y="2.5"
        width="5"
        height="9"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="8"
        y="2.5"
        width="5"
        height="9"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2 1.5"
        opacity="0.7"
      />
    </svg>
  );
}
