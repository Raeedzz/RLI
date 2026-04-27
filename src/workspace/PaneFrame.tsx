import { AnimatePresence } from "motion/react";
import { useState, type DragEvent, type ReactNode } from "react";
import { SplitChooser } from "./SplitChooser";
import { useActiveSession, useAppDispatch } from "@/state/AppState";
import type { PaneContent, PaneNodeId, SplitDirection } from "@/state/types";
import { usePaneDrag } from "./PaneDragContext";

type DropZone = "left" | "right" | "up" | "down" | "center";

/**
 * Map a drop point inside a pane's bounding rect to one of the five
 * drop zones. The center occupies the inner ~50% (cursor more than 25%
 * from every edge); otherwise we pick whichever edge is closest.
 *
 * Edge detection is what makes drag-to-rearrange feel like a real
 * editor — dropping on the right edge of pane A lands the dragged pane
 * to A's right, instead of just swapping content.
 */
function detectDropZone(e: DragEvent<HTMLDivElement>, rect: DOMRect): DropZone {
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const dLeft = x;
  const dRight = 1 - x;
  const dUp = y;
  const dDown = 1 - y;
  const min = Math.min(dLeft, dRight, dUp, dDown);
  if (min > 0.25) return "center";
  if (min === dLeft) return "left";
  if (min === dRight) return "right";
  if (min === dUp) return "up";
  return "down";
}

/** Map a drop zone to its `SplitDirection`, or null for the center swap. */
function zoneToDirection(zone: DropZone): SplitDirection | null {
  switch (zone) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "up":
      return "up";
    case "down":
      return "down";
    case "center":
      return null;
  }
}

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
  const session = useActiveSession();
  const { isDragging, draggingRef, setDragging } = usePaneDrag();
  const [chooser, setChooser] = useState<{
    anchor: { x: number; y: number };
    mode: "split" | "replace";
  } | null>(null);
  // null = cursor not over this pane; otherwise the active drop zone
  // (which edge the cursor is hovering over, or "center" for a swap).
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const workspace = session?.workspace;

  const onSplit = (direction: SplitDirection, newContent: PaneContent) => {
    if (!session) return;
    dispatch({
      type: "split-pane",
      sessionId: session.id,
      paneId,
      direction,
      content: newContent,
    });
    setChooser(null);
  };

  const onReplace = (newContent: PaneContent) => {
    if (!session) return;
    dispatch({
      type: "set-pane-content",
      sessionId: session.id,
      paneId,
      content: newContent,
    });
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
    setDragging(true);
  };

  const onDragEnd = () => {
    setDragging(false);
    setDropZone(null);
  };

  // We don't filter by `dataTransfer.types` here — WebKit hides custom
  // MIME types during dragover. Instead we read the synchronous
  // `draggingRef` (set inside the `dragstart` callback before React
  // commits its state update) to decide whether this is our drag.
  // Reading `isDragging` from context would race the very first
  // dragover events past their preventDefault window and silently
  // break drop firing.
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    // Stop bubbling so the inner shield's calculation wins; otherwise
    // the outer wrapper would overwrite it with its larger rect (which
    // includes the header) and the highlighted zone would no longer
    // match what the user sees in the body.
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = detectDropZone(e, rect);
    if (zone !== dropZone) setDropZone(zone);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only clear if we actually left the pane wrapper — dragleave fires
    // every time the cursor crosses any nested boundary (e.g. into the
    // header, into xterm's canvas), which would otherwise strobe the
    // overlay off and on.
    const rect = e.currentTarget.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      setDropZone(null);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Stop here so the drop doesn't bubble up and fire a duplicate
    // dispatch on an outer wrapper that listens for the same event.
    e.stopPropagation();
    // Compute the zone from the drop event itself rather than reading
    // it from React state — `dropZone` may not have flushed yet by the
    // time `drop` fires, leading to stale values and missed snaps.
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = detectDropZone(e, rect);
    setDropZone(null);
    setDragging(false);
    if (!session) return;
    const sourceId = e.dataTransfer.getData(DRAG_MIME);
    if (!sourceId || sourceId === paneId) return;
    const direction = zoneToDirection(zone);
    if (direction === null) {
      // Center → swap content. Useful when you just want to flip
      // two panes without rearranging the tree.
      dispatch({
        type: "swap-panes",
        sessionId: session.id,
        aId: sourceId,
        bId: paneId,
      });
    } else {
      dispatch({
        type: "move-pane",
        sessionId: session.id,
        sourceId,
        targetId: paneId,
        direction,
      });
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
        outline: dropZone ? "2px solid var(--accent-bright)" : "none",
        outlineOffset: -2,
        transition:
          "outline-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
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
            onClick={() => {
              if (!session) return;
              dispatch({
                type: "close-pane",
                sessionId: session.id,
                paneId,
              });
            }}
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
        {/* Drop shield: while any pane is being dragged, this transparent
            overlay sits above the body and captures dragover/drop events
            directly. Inner widgets (xterm canvas, CodeMirror, GStack
            screenshot iframe) often have their own drag handlers that
            would otherwise swallow these events before they reach our
            outer wrapper — so the shield is the canonical drop target
            during a drag and snaps the pane into place reliably. */}
        {isDragging && (
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "transparent",
              zIndex: 20,
            }}
          />
        )}
        {dropZone && <DropZoneOverlay zone={dropZone} />}
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
            workspaceLeafCount={workspace ? leafCount(workspace) : 1}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Translucent accent overlay covering the half (or whole) of the pane
 * that the dragged source will land on. Visual key to the user about
 * what dropping right now will do — a center hover floods the pane
 * (swap), an edge hover lights up that side (split-and-place).
 */
function DropZoneOverlay({ zone }: { zone: DropZone }) {
  const tint = "color-mix(in oklch, transparent, var(--accent-bright) 18%)";
  const base = {
    position: "absolute" as const,
    pointerEvents: "none" as const,
    backgroundColor: tint,
    borderRadius: "var(--radius-md)",
    transition:
      "inset var(--motion-instant) var(--ease-out-quart)",
  };
  switch (zone) {
    case "center":
      return <div aria-hidden style={{ ...base, inset: 0 }} />;
    case "left":
      return <div aria-hidden style={{ ...base, top: 0, bottom: 0, left: 0, width: "50%" }} />;
    case "right":
      return <div aria-hidden style={{ ...base, top: 0, bottom: 0, right: 0, width: "50%" }} />;
    case "up":
      return <div aria-hidden style={{ ...base, left: 0, right: 0, top: 0, height: "50%" }} />;
    case "down":
      return <div aria-hidden style={{ ...base, left: 0, right: 0, bottom: 0, height: "50%" }} />;
  }
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
