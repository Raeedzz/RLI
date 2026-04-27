import { describe, expect, test } from "bun:test";
import {
  closeLeaf,
  defaultWorkspaceWithEditor,
  findLeaf,
  leaves,
  makeLeaf,
  movePane,
  setLeafContent,
  splitLeaf,
  swapLeaves,
} from "./paneTree";
import type { PaneNode } from "./types";

const T = makeLeaf("terminal", "T");
const E = makeLeaf("editor", "E");

describe("leaves + findLeaf", () => {
  test("a single leaf yields itself", () => {
    expect(leaves(T).map((l) => l.id)).toEqual(["T"]);
    expect(findLeaf(T, "T")).toBe(T);
  });

  test("a split yields its leaves left → right", () => {
    const root: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    expect(leaves(root).map((l) => l.id)).toEqual(["T", "E"]);
    expect(findLeaf(root, "E")?.content).toBe("editor");
  });

  test("findLeaf returns null for missing id", () => {
    expect(findLeaf(T, "missing")).toBe(null);
  });
});

describe("splitLeaf", () => {
  test("'right' creates a horizontal split with the new pane on the right", () => {
    const out = splitLeaf(T, "T", "right", "editor");
    expect(out.kind).toBe("split");
    if (out.kind !== "split") return;
    expect(out.direction).toBe("horizontal");
    const [left, right] = out.children;
    expect(left.kind === "leaf" && left.content).toBe("terminal");
    expect(right.kind === "leaf" && right.content).toBe("editor");
  });

  test("'left' creates a horizontal split with the new pane on the left", () => {
    const out = splitLeaf(T, "T", "left", "editor");
    if (out.kind !== "split") throw new Error("expected split");
    const [first, second] = out.children;
    expect(first.kind === "leaf" && first.content).toBe("editor");
    expect(second.kind === "leaf" && second.content).toBe("terminal");
  });

  test("'down' creates a vertical split with the new pane below", () => {
    const out = splitLeaf(T, "T", "down", "browser");
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.direction).toBe("vertical");
    const [top, bottom] = out.children;
    expect(top.kind === "leaf" && top.content).toBe("terminal");
    expect(bottom.kind === "leaf" && bottom.content).toBe("browser");
  });

  test("'up' creates a vertical split with the new pane above", () => {
    const out = splitLeaf(T, "T", "up", "browser");
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.direction).toBe("vertical");
    const [top, bottom] = out.children;
    expect(top.kind === "leaf" && top.content).toBe("browser");
    expect(bottom.kind === "leaf" && bottom.content).toBe("terminal");
  });

  test("an unknown id leaves the tree unchanged", () => {
    const root = defaultWorkspaceWithEditor();
    expect(splitLeaf(root, "nope", "right", "browser")).toEqual(root);
  });

  test("can split a deeply nested leaf without disturbing siblings", () => {
    // Root: H-split of [terminal, V-split of [editor, browser]]
    const browser = makeLeaf("browser", "B");
    const inner: PaneNode = {
      kind: "split",
      id: "inner",
      direction: "vertical",
      children: [E, browser],
    };
    const root: PaneNode = {
      kind: "split",
      id: "outer",
      direction: "horizontal",
      children: [T, inner],
    };
    const out = splitLeaf(root, "B", "right", "terminal");
    const allContents = leaves(out).map((l) => l.content);
    // Original three plus a new terminal beside the browser
    expect(allContents).toEqual(["terminal", "editor", "browser", "terminal"]);
  });
});

describe("closeLeaf", () => {
  test("closing a leaf in a 2-pane split collapses to the sibling", () => {
    const split: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    expect(closeLeaf(split, "T")).toBe(E);
    expect(closeLeaf(split, "E")).toBe(T);
  });

  test("closing the only leaf is a no-op", () => {
    expect(closeLeaf(T, "T")).toBe(T);
  });

  test("closing a leaf in a nested tree preserves structure", () => {
    const browser = makeLeaf("browser", "B");
    const inner: PaneNode = {
      kind: "split",
      id: "inner",
      direction: "vertical",
      children: [E, browser],
    };
    const root: PaneNode = {
      kind: "split",
      id: "outer",
      direction: "horizontal",
      children: [T, inner],
    };
    const out = closeLeaf(root, "B");
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.children[0]).toBe(T);
    expect(out.children[1]).toBe(E); // inner collapsed since only one child left
  });
});

describe("setLeafContent", () => {
  test("updates the matching leaf only", () => {
    const split: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    const out = setLeafContent(split, "T", "browser");
    const cs = leaves(out).map((l) => l.content);
    expect(cs).toEqual(["browser", "editor"]);
  });

  test("preserves leaf id (so React keys remain stable)", () => {
    const out = setLeafContent(T, "T", "browser");
    if (out.kind !== "leaf") throw new Error("expected leaf");
    expect(out.id).toBe("T");
  });
});

describe("swapLeaves", () => {
  test("swaps the contents of two leaves while preserving ids", () => {
    const split: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    const out = swapLeaves(split, "T", "E");
    const ls = leaves(out);
    // T id now has editor content; E id now has terminal content
    expect(ls[0].id).toBe("T");
    expect(ls[0].content).toBe("editor");
    expect(ls[1].id).toBe("E");
    expect(ls[1].content).toBe("terminal");
  });

  test("swap with self is a no-op", () => {
    const out = swapLeaves(T, "T", "T");
    expect(out).toBe(T);
  });

  test("swap with unknown id leaves the tree unchanged", () => {
    expect(swapLeaves(T, "T", "missing")).toBe(T);
  });
});

describe("movePane", () => {
  test("moving across in a 2-pane tree swaps positions", () => {
    // [T | E] → drop T on E's right → [E | T_new]
    const root: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    const out = movePane(root, "T", "E", "right");
    const ls = leaves(out);
    expect(ls.map((l) => l.content)).toEqual(["editor", "terminal"]);
  });

  test("moving onto a sibling's left places source before target", () => {
    const root: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    // Move E onto T's left → [E_new | T]
    const out = movePane(root, "E", "T", "left");
    const ls = leaves(out);
    expect(ls.map((l) => l.content)).toEqual(["editor", "terminal"]);
  });

  test("moving onto a target's bottom creates a vertical split", () => {
    const B = makeLeaf("browser", "B");
    // 3-pane tree: T on the left, [E | B] on the right. Move B down
    // onto E so the right side becomes [E above B] vertically.
    const root3: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [
        T,
        {
          kind: "split",
          id: "s2",
          direction: "horizontal",
          children: [E, B],
        },
      ],
    };
    const out = movePane(root3, "B", "E", "down");
    // After: T is unchanged on the left; right side is E stacked over B.
    expect(out.kind).toBe("split");
    if (out.kind !== "split") return;
    expect(out.children[0].kind).toBe("leaf");
    expect(out.children[1].kind).toBe("split");
    if (out.children[1].kind === "split") {
      expect(out.children[1].direction).toBe("vertical");
      const sub = leaves(out.children[1]);
      expect(sub[0].content).toBe("editor");
      expect(sub[1].content).toBe("browser");
    }
  });

  test("moving onto self is a no-op", () => {
    const root: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    expect(movePane(root, "T", "T", "right")).toBe(root);
  });

  test("moving with unknown source returns the tree unchanged", () => {
    const root: PaneNode = {
      kind: "split",
      id: "s",
      direction: "horizontal",
      children: [T, E],
    };
    expect(movePane(root, "missing", "T", "right")).toBe(root);
  });

  test("moving the only leaf is a no-op", () => {
    expect(movePane(T, "T", "T", "right")).toBe(T);
  });
});
