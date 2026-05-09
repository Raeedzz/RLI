import { useState } from "react";
import {
  CLAUDE_PLAN_BUDGETS,
  formatTokenCount,
  useClaudeUsage,
  writeClaudePlan,
  type ClaudePlanTier,
  type ClaudeUsageDerived,
  type ClaudeUsageStatus,
} from "@/lib/claudeUsage";
import { useAppState } from "@/state/AppState";
import type { TerminalTab } from "@/state/types";

/**
 * Compact Claude usage indicator. Sources its numbers from the real
 * Claude Code transcript files via the `useClaudeUsage` hook. The
 * window is the CURRENT 5h Claude session (anchored on the first
 * message after the previous session expired) — same scope as
 * Claude.ai's "Current session" indicator.
 *
 *   ┌────────────────────────────────────────┐
 *   │ ✻ 13% · 3h 36m · 296M tok             │
 *   └────────────────────────────────────────┘
 *
 * Click the pill to switch plan tier (Pro / Max 5x / Max 20x). The
 * choice persists in localStorage and adjusts the % denominator.
 */
export function ClaudePill() {
  const { status, derived } = useClaudeUsage();
  const state = useAppState();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Hard gate: only render when a terminal tab in any worktree is
  // currently running an agent. Worktree.agentStatus and TerminalTab
  // .agentStatus both flip via BlockTerminal's onAgentRunningChange.
  const anyAgentRunning =
    Object.values(state.worktrees).some((w) => w.agentStatus === "running") ||
    Object.values(state.tabs).some(
      (t): t is TerminalTab => t.kind === "terminal" && t.agentStatus === "running",
    );
  if (!anyAgentRunning) return null;

  if (!status || !status.active || !derived) return null;

  // Tone tracks TOKEN spend now that we have a real denominator.
  // <50% green, <80% amber, ≥80% red. Mirrors Claude.ai's own
  // visual language for the session bar.
  const tone =
    derived.fractionUsed >= 0.8
      ? "var(--state-error)"
      : derived.fractionUsed >= 0.5
        ? "var(--state-warning)"
        : "var(--state-success)";

  return (
    <span
      role="status"
      title={buildTooltip(status, derived)}
      onClick={(e) => {
        // No point opening the plan picker when the real source is in
        // play — the % comes from Anthropic, plan choice is irrelevant.
        if (derived.realSource) return;
        e.stopPropagation();
        setPickerOpen((v) => !v);
      }}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1-5)",
        height: 16,
        padding: "0 var(--space-1-5)",
        flexShrink: 0,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-tertiary)",
        letterSpacing: "var(--tracking-tight)",
        cursor: derived.realSource ? "default" : "pointer",
      }}
    >
      <ClaudeMark color="var(--state-warning)" />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontVariantNumeric: "tabular-nums",
          color: tone,
          fontWeight: "var(--weight-medium)",
        }}
      >
        {derived.percentUsedLabel}
      </span>
      <Sep />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-tertiary)",
        }}
      >
        {derived.remainingLabel}
      </span>
      <Sep />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantLigatures: "none",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-tertiary)",
        }}
      >
        {derived.totalTokensLabel} tok
      </span>
      {pickerOpen && (
        <PlanPicker
          current={derived.plan}
          onPick={(tier) => {
            writeClaudePlan(tier);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </span>
  );
}

function PlanPicker({
  current,
  onPick,
  onClose,
}: {
  current: ClaudePlanTier;
  onPick: (tier: ClaudePlanTier) => void;
  onClose: () => void;
}) {
  const items: Array<{ id: ClaudePlanTier; label: string }> = [
    { id: "pro", label: "Pro" },
    { id: "max5", label: "Max 5x" },
    { id: "max20", label: "Max 20x" },
  ];
  return (
    <>
      <div
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99,
        }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          right: 0,
          bottom: 22,
          zIndex: 100,
          minWidth: 160,
          padding: "var(--space-1)",
          backgroundColor: "var(--surface-2)",
          border: "var(--border-1)",
          borderRadius: "var(--radius-sm)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <div
          style={{
            padding: "var(--space-1) var(--space-2)",
            fontSize: "var(--text-2xs)",
            color: "var(--text-tertiary)",
            letterSpacing: "var(--tracking-wide)",
            textTransform: "uppercase",
          }}
        >
          Plan
        </div>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => onPick(it.id)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "var(--space-1-5) var(--space-2)",
              backgroundColor:
                current === it.id ? "var(--surface-3)" : "transparent",
              border: "none",
              borderRadius: "var(--radius-xs)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-primary)",
              textAlign: "left",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              if (current !== it.id) {
                e.currentTarget.style.backgroundColor = "var(--surface-3)";
              }
            }}
            onMouseLeave={(e) => {
              if (current !== it.id) {
                e.currentTarget.style.backgroundColor = "transparent";
              }
            }}
          >
            <span>{it.label}</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                color: "var(--text-tertiary)",
              }}
            >
              {formatTokenCount(CLAUDE_PLAN_BUDGETS[it.id])}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function buildTooltip(s: ClaudeUsageStatus, d: ClaudeUsageDerived): string {
  const lines: string[] = [];
  if (d.realSource) {
    lines.push(
      `Claude · ${d.percentUsedLabel} used (5h) · resets in ${d.remainingLabel}`,
    );
    if (d.sevenDayPercent != null) {
      lines.push(`weekly: ${Math.round(d.sevenDayPercent)}% used`);
    }
    lines.push(`source: Anthropic (status-line hook)`);
  } else {
    lines.push(
      `Claude ${planLabel(d.plan)} · ${d.percentUsedLabel} used · resets in ${d.remainingLabel}`,
    );
    lines.push(
      `source: estimate (install ~/.claude/hooks/rli-usage-capture.sh for exact %)`,
    );
  }
  lines.push(
    `${s.message_count} messages · ${formatTokenCount(s.total_input_tokens)} in / ${formatTokenCount(s.total_output_tokens)} out`,
  );
  if (s.total_cache_read_tokens > 0 || s.total_cache_creation_tokens > 0) {
    lines.push(
      `cache: ${formatTokenCount(s.total_cache_read_tokens)} read · ${formatTokenCount(s.total_cache_creation_tokens)} created`,
    );
  }
  const models = Object.entries(s.by_model).sort(
    (a, b) => b[1].messages - a[1].messages,
  );
  if (models.length > 0) {
    for (const [model, b] of models) {
      lines.push(
        `  ${model}: ${b.messages} msgs · ${formatTokenCount(b.output_tokens)} out`,
      );
    }
  }
  if (!d.realSource) lines.push("(click to switch plan)");
  return lines.join("\n");
}

function planLabel(p: ClaudePlanTier): string {
  if (p === "pro") return "Pro";
  if (p === "max5") return "Max 5x";
  return "Max 20x";
}

function Sep() {
  return (
    <span
      aria-hidden
      style={{ color: "var(--text-disabled)", fontFamily: "var(--font-mono)" }}
    >
      ·
    </span>
  );
}

function ClaudeMark({ color }: { color: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, color }}
    >
      <path
        d="M6 1.2 V10.8 M1.5 3.4 L10.5 8.6 M1.5 8.6 L10.5 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
