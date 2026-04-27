import { describe, expect, test } from "bun:test";
import { statusVisual } from "./useGitStatus";

describe("statusVisual", () => {
  test("returns null for undefined entries", () => {
    expect(statusVisual(undefined)).toBe(null);
  });

  test("added → diff-add green badge 'A'", () => {
    const v = statusVisual({ path: "x", kind: "added", staged: true });
    expect(v?.color).toBe("var(--diff-add-fg)");
    expect(v?.badge).toBe("A");
    expect(v?.label).toContain("staged");
  });

  test("untracked also reads as new (green) with 'U'", () => {
    const v = statusVisual({ path: "x", kind: "untracked", staged: false });
    expect(v?.color).toBe("var(--diff-add-fg)");
    expect(v?.badge).toBe("U");
  });

  test("deleted → diff-remove red badge 'D'", () => {
    const v = statusVisual({ path: "x", kind: "deleted", staged: true });
    expect(v?.color).toBe("var(--diff-remove-fg)");
    expect(v?.badge).toBe("D");
  });

  test("modified → warning amber badge 'M'", () => {
    const v = statusVisual({ path: "x", kind: "modified", staged: false });
    expect(v?.color).toBe("var(--state-warning)");
    expect(v?.badge).toBe("M");
  });

  test("renamed → info blue badge 'R'", () => {
    const v = statusVisual({ path: "x", kind: "renamed", staged: true });
    expect(v?.color).toBe("var(--state-info)");
    expect(v?.badge).toBe("R");
  });

  test("conflicted → error red bang badge", () => {
    const v = statusVisual({ path: "x", kind: "conflicted", staged: false });
    expect(v?.color).toBe("var(--state-error)");
    expect(v?.badge).toBe("!");
  });

  test("unknown kind returns null", () => {
    expect(statusVisual({ path: "x", kind: "weird", staged: false })).toBe(null);
  });

  test("staged flag is reflected in the label for stage-able kinds", () => {
    expect(statusVisual({ path: "x", kind: "added", staged: true })?.label).toBe(
      "added (staged)",
    );
    expect(statusVisual({ path: "x", kind: "added", staged: false })?.label).toBe(
      "added",
    );
  });
});
