import { describe, expect, test } from "bun:test";
import {
  CLAUDE_WINDOW_MS,
  computeClaudeUsage,
  detectClaude,
  formatDuration,
} from "./claudeUsage";

describe("detectClaude", () => {
  test("matches the Claude Code banner case-insensitively", () => {
    expect(detectClaude("Claude Code v1.2.3")).toBe(true);
    expect(detectClaude("CLAUDE CODE")).toBe(true);
    expect(detectClaude("welcome to claude code, raeed")).toBe(true);
  });

  test("matches the Claude TUI welcome glyph", () => {
    expect(detectClaude("│ ✻ Welcome to Claude")).toBe(true);
  });

  test("matches anthropic.com mentions", () => {
    expect(detectClaude("Visit https://anthropic.com for docs")).toBe(true);
  });

  test("returns false for unrelated terminal output", () => {
    expect(detectClaude("$ ls -la\ntotal 42\ndrwxr-xr-x ...")).toBe(false);
    expect(detectClaude("npm install ✓")).toBe(false);
    expect(detectClaude("")).toBe(false);
  });

  test("returns false for the substring 'claude' alone (must be Claude Code)", () => {
    expect(detectClaude("claude")).toBe(false);
    expect(detectClaude("a user named claude")).toBe(false);
  });
});

describe("computeClaudeUsage", () => {
  test("at t=0 reports the full 5h window remaining", () => {
    const t = 1_700_000_000_000;
    const status = computeClaudeUsage(t, t);
    expect(status.remainingMs).toBe(CLAUDE_WINDOW_MS);
    expect(status.fractionUsed).toBe(0);
    expect(status.remainingLabel).toBe("5h 00m");
  });

  test("at t=3h reports 2h 00m remaining", () => {
    const start = 0;
    const now = 3 * 60 * 60 * 1000;
    const status = computeClaudeUsage(start, now);
    expect(status.remainingMs).toBe(2 * 60 * 60 * 1000);
    expect(status.remainingLabel).toBe("2h 00m");
    expect(status.fractionUsed).toBeCloseTo(0.6, 5);
  });

  test("at t > 5h saturates to 0 remaining and fraction=1", () => {
    const status = computeClaudeUsage(0, 6 * 60 * 60 * 1000);
    expect(status.remainingMs).toBe(0);
    expect(status.fractionUsed).toBe(1);
    expect(status.remainingLabel).toBe("0m");
  });

  test("clamps elapsed to >= 0 if clock skewed backward", () => {
    const status = computeClaudeUsage(2000, 1000);
    expect(status.fractionUsed).toBe(0);
    expect(status.remainingMs).toBe(CLAUDE_WINDOW_MS);
  });
});

describe("formatDuration", () => {
  test("returns '0m' for non-positive input", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-500)).toBe("0m");
  });

  test("uses seconds when under a minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("uses minutes-only when under an hour", () => {
    expect(formatDuration(30 * 60 * 1000)).toBe("30m");
    expect(formatDuration(59 * 60 * 1000)).toBe("59m");
  });

  test("uses hours+minutes when over an hour, zero-padding the minutes", () => {
    expect(formatDuration(60 * 60 * 1000)).toBe("1h 00m");
    expect(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe("2h 05m");
    expect(formatDuration(5 * 60 * 60 * 1000)).toBe("5h 00m");
  });
});
