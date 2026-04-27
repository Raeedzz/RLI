/**
 * Pure helpers for manipulating the workspace pane tree.
 *
 * The tree is a binary recursive structure — each node is either a
 * leaf (a single Terminal/Editor/Browser) or a split (two children
 * arranged horizontally or vertically). All transforms below return
 * a new tree; the input is never mutated, so React picks up changes
 * via reference equality.
 */

import type {
  PaneContent,
  PaneLeaf,
  PaneNode,
  PaneNodeId,
  SplitDirection,
} from "./types";

let idCounter = 0;
export function newPaneId(prefix = "pane"): PaneNodeId {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function makeLeaf(content: PaneContent, id?: PaneNodeId): PaneLeaf {
  return { kind: "leaf", id: id ?? newPaneId(), content };
}

/** Walk the tree and yield every leaf node in left/top → right/bottom order. */
export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...leaves(node.children[0]), ...leaves(node.children[1])];
}

/** Find the leaf with the given id, or null if no such leaf exists. */
export function findLeaf(node: PaneNode, id: PaneNodeId): PaneLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
}

/**
 * Splits the leaf with `targetId` into a new split node.
 *
 * - `direction: 'right' | 'down'` → the new pane appears after the original
 * - `direction: 'left' | 'up'`    → the new pane appears before the original
 * - `right`/`left` create a horizontal split (side-by-side)
 * - `up`/`down`    create a vertical split (stacked)
 *
 * If `targetId` doesn't match any leaf, returns the tree unchanged.
 */
export function splitLeaf(
  root: PaneNode,
  targetId: PaneNodeId,
  direction: SplitDirection,
  newContent: PaneContent,
): PaneNode {
  const transform = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      if (node.id !== targetId) return node;
      const newPane = makeLeaf(newContent);
      const splitDirection: "horizontal" | "vertical" =
        direction === "left" || direction === "right" ? "horizontal" : "vertical";
      const children: [PaneNode, PaneNode] =
        direction === "right" || direction === "down"
          ? [node, newPane]
          : [newPane, node];
      return {
        kind: "split",
        id: newPaneId("split"),
        direction: splitDirection,
        children,
      };
    }
    return {
      ...node,
      children: [transform(node.children[0]), transform(node.children[1])],
    };
  };
  return transform(root);
}

/**
 * Closes the leaf with `targetId`. The parent split collapses, leaving
 * the sibling in its place. Closing the last leaf is a no-op — the
 * workspace must always have at least one pane.
 */
export function closeLeaf(root: PaneNode, targetId: PaneNodeId): PaneNode {
  if (root.kind === "leaf") {
    // Don't allow closing the only pane
    return root;
  }
  const [a, b] = root.children;
  if (a.kind === "leaf" && a.id === targetId) return b;
  if (b.kind === "leaf" && b.id === targetId) return a;
  return {
    ...root,
    children: [closeLeaf(a, targetId), closeLeaf(b, targetId)],
  };
}

/** Replace the content of a leaf with a different content kind. */
export function setLeafContent(
  root: PaneNode,
  targetId: PaneNodeId,
  content: PaneContent,
): PaneNode {
  if (root.kind === "leaf") {
    if (root.id !== targetId) return root;
    return { ...root, content };
  }
  return {
    ...root,
    children: [
      setLeafContent(root.children[0], targetId, content),
      setLeafContent(root.children[1], targetId, content),
    ],
  };
}

/**
 * Swap the contents of two leaves identified by id. If either id can't
 * be found, the tree is returned unchanged. Used by drag-to-rearrange.
 */
export function swapLeaves(
  root: PaneNode,
  aId: PaneNodeId,
  bId: PaneNodeId,
): PaneNode {
  if (aId === bId) return root;
  const a = findLeaf(root, aId);
  const b = findLeaf(root, bId);
  if (!a || !b) return root;
  // We only swap content — keeping leaf ids stable preserves React keys.
  let tree = setLeafContent(root, aId, b.content);
  tree = setLeafContent(tree, bId, a.content);
  return tree;
}

/**
 * Move the leaf with `sourceId` to a new position adjacent to the leaf
 * with `targetId`. Used by drag-and-drop with edge-zone detection: drop
 * on a target's left/right edge to land that pane on that side, etc.
 *
 * Implementation: pluck the source's content (`PaneContent`) out, drop
 * the source leaf from the tree, then split the target with the source's
 * content in the requested direction. The new pane gets a fresh id —
 * losing the old leaf id is fine since drag-and-drop never preserves
 * outer identity (xterm/CodeMirror are unmounted by the React key
 * change anyway).
 *
 * No-op if either leaf is missing, source === target, or sourceId is the
 * tree root (a single-leaf tree has nothing to "move within").
 */
export function movePane(
  root: PaneNode,
  sourceId: PaneNodeId,
  targetId: PaneNodeId,
  direction: SplitDirection,
): PaneNode {
  if (sourceId === targetId) return root;
  const source = findLeaf(root, sourceId);
  const target = findLeaf(root, targetId);
  if (!source || !target) return root;
  const trimmed = closeLeaf(root, sourceId);
  // closeLeaf is a no-op when source is the only leaf — guard against
  // re-splitting on the same content (would just look like a no-op too,
  // but defending here keeps the intent explicit).
  if (trimmed === root && root.kind === "leaf") return root;
  return splitLeaf(trimmed, targetId, direction, source.content);
}

/** Default workspace tree — single terminal. */
export function defaultWorkspace(): PaneNode {
  return makeLeaf("terminal", "pane-default-terminal");
}

/** Default workspace tree — terminal middle, editor right (matches the legacy layout). */
export function defaultWorkspaceWithEditor(): PaneNode {
  return {
    kind: "split",
    id: "split-default",
    direction: "horizontal",
    children: [
      makeLeaf("terminal", "pane-default-terminal"),
      makeLeaf("editor", "pane-default-editor"),
    ],
  };
}
