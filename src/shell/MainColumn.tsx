import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  IconPlus,
  IconClose,
  IconRunning,
} from "@/design/icons";
import {
  useActiveProject,
  useActiveTab,
  useActiveWorktree,
  useAppDispatch,
  useAppState,
  useWorktreeTabs,
} from "@/state/AppState";
import type { Tab, TerminalTab, Worktree } from "@/state/types";
import { ErrorBoundary } from "./ErrorBoundary";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { DiffView } from "@/git/DiffView";
import { Editor } from "@/editor/Editor";
import { fs } from "@/lib/fs";
import { RepositorySettingsView } from "./RepositorySettingsView";

/**
 * Center column. Top row: breadcrumb + workspace selector. Then the
 * tab strip (terminal / diff / markdown). Then the active tab's content.
 * Bottom: chatbox.
 */
export function MainColumn() {
  const project = useActiveProject();
  const worktree = useActiveWorktree();
  const tabs = useWorktreeTabs(worktree?.id ?? null);
  const activeTab = useActiveTab();

  if (!project || !worktree) {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-sm)",
        }}
      >
        Open a project to begin.
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        backgroundColor: "var(--surface-2)",
      }}
    >
      <TabStrip tabs={tabs} activeTabId={activeTab?.id ?? null} worktreeId={worktree.id} />
      <TabContent
        worktree={worktree}
        tab={activeTab}
        projectPath={project.path}
      />
    </div>
  );
}

/* ------------------------------------------------------------------
   Breadcrumb
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Tab strip
   ------------------------------------------------------------------ */

function TabStrip({
  tabs,
  activeTabId,
  worktreeId,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  worktreeId: string;
}) {
  const dispatch = useAppDispatch();

  const onNewTerminalTab = () => {
    // Both ids carry a random suffix on top of Date.now(): two clicks
    // landing in the same millisecond previously produced colliding
    // ptyIds, which made the new tab attach to an already-running PTY
    // (e.g. interrupting a running `claude` session in the prior tab).
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    const id = `t_${stamp}_${rand}`;
    const ptyId = `pty_${stamp}_${rand}`;
    dispatch({
      type: "open-tab",
      tab: {
        id,
        worktreeId,
        kind: "terminal",
        ptyId,
        title: "Untitled",
        summary: "ready",
        summaryUpdatedAt: Date.now(),
        detectedCli: null,
        agentStatus: "idle",
      },
    });
  };

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        alignItems: "center",
        height: "var(--tab-height)",
        padding: "0 var(--space-1)",
        backgroundColor: "var(--surface-1)",
        borderBottom: "var(--border-1)",
        gap: 2,
        overflowX: "auto",
      }}
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          worktreeId={worktreeId}
        />
      ))}
      <button
        type="button"
        title="New terminal tab"
        onClick={onNewTerminalTab}
        style={{
          width: 28,
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          borderRadius: "var(--radius-sm)",
          flexShrink: 0,
          transition:
            "background-color var(--motion-instant) var(--ease-out-quart)," +
            "color var(--motion-instant) var(--ease-out-quart)",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.backgroundColor = "var(--surface-3)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--text-tertiary)";
        }}
      >
        <IconPlus size={14} />
      </button>
    </div>
  );
}

function TabButton({
  tab,
  active,
  worktreeId,
}: {
  tab: Tab;
  active: boolean;
  worktreeId: string;
}) {
  const dispatch = useAppDispatch();
  const isRunning = tab.kind === "terminal" && tab.agentStatus === "running";

  return (
    <motion.div
      role="tab"
      aria-selected={active}
      layout
      initial={{ opacity: 0, x: 6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, y: 3 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      onClick={() =>
        dispatch({ type: "select-tab", worktreeId, id: tab.id })
      }
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        minWidth: 120,
        maxWidth: 240,
        padding: "0 var(--space-2) 0 10px",
        cursor: "default",
        backgroundColor: active ? "var(--surface-2)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          color: isRunning ? "var(--accent)" : "var(--text-tertiary)",
        }}
      >
        {isRunning ? (
          <span className="rli-loader-spin">
            <IconRunning size={14} />
          </span>
        ) : (
          <TabKindGlyph tab={tab} />
        )}
      </span>
      <TabLabelStack tab={tab} />
      <span style={{ flex: 1, minWidth: 0 }} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: "close-tab", id: tab.id });
        }}
        title="Close tab"
        style={{
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-tertiary)",
          opacity: active ? 1 : 0.65,
          borderRadius: "var(--radius-xs)",
        }}
      >
        <IconClose size={12} />
      </button>
      {active && (
        <motion.span
          layoutId="rli-active-tab-underline"
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            bottom: 0,
            height: 1,
            backgroundColor: "var(--accent)",
          }}
          transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
        />
      )}
    </motion.div>
  );
}

/**
 * Two-line stack rendered inside a tab: the session title on top, a
 * live one-line summary underneath. The summary is what makes the
 * tab strip a glance-tool — at any moment the user can read what
 * each parallel session is doing without switching tabs.
 *
 * Keeps the row height fixed so the chrome doesn't reflow when a
 * summary arrives or clears.
 */
function TabLabelStack({ tab }: { tab: Tab }) {
  const title = tabLabel(tab);
  const summary = tabSummary(tab);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 1,
        minWidth: 0,
        maxWidth: 200,
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: "var(--weight-medium)",
          letterSpacing: "var(--tracking-tight)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      {summary && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </span>
      )}
    </div>
  );
}

/**
 * Pick the one-line summary to show under the tab title. We trust
 * `tab.summary` (set by BlockTerminal via the helper-agent layer or
 * the activeCommand fallback) for terminal tabs, and fall back to
 * the file path for file-backed tabs so the line still carries
 * information. Strings are truncated to a reasonable display width
 * client-side; CSS handles the visual ellipsis.
 */
function tabSummary(tab: Tab): string {
  const trim = (s: string | undefined | null): string => {
    if (!s) return "";
    const cleaned = s.replace(/\s+/g, " ").trim();
    if (cleaned === "ready" || cleaned === "Untitled") return "";
    return cleaned;
  };
  if (tab.kind === "terminal") return trim(tab.summary);
  if (tab.kind === "diff" || tab.kind === "markdown") {
    return trim(tab.filePath);
  }
  return trim(tab.summary);
}

/** Bare label for a tab — bare names only (no path, no subtitle).
 *  Terminal tabs only surface the CLI badge ("claude" / "codex" /
 *  "gemini") while the agent is actively running. Once it exits the
 *  tab reverts to its session title (or "shell" by default) so the
 *  strip doesn't keep showing a long-dead agent's name. detectedCli
 *  alone is unreliable for this: the exit-debounce in BlockTerminal
 *  can be cancelled if the user switches tabs mid-flight, leaving the
 *  CLI field stale until the user navigates back. Anding it with
 *  agentStatus closes the gap. */
function tabLabel(tab: Tab): string {
  if (tab.kind === "terminal") {
    if (tab.agentStatus === "running" && tab.detectedCli) {
      return tab.detectedCli;
    }
    // Once the agent is gone the tab reverts to "shell", period.
    // We deliberately don't fall back to tab.title here — the title
    // can hold residue from the just-exited agent (e.g. "claude"
    // becomes the derived title when activity summary was just the
    // launch command), and the user wants the tab to read as the
    // base shell state, not a stale agent name. The longer activity
    // summary still surfaces in the 11px tertiary line under the
    // tab title (rendered by TabLabelStack), so meaningful session
    // context isn't lost — only the badge resets.
    return "shell";
  }
  if (tab.kind === "project-settings") {
    return tab.title || "Settings";
  }
  // diff / markdown — show the filename basename.
  return tab.filePath.split("/").pop() ?? tab.title;
}

function TabKindGlyph({ tab }: { tab: Tab }) {
  const dot = (color: string) => (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: "var(--radius-pill)",
        backgroundColor: color,
        display: "inline-block",
      }}
    />
  );
  if (tab.kind === "terminal") return dot("var(--text-tertiary)");
  if (tab.kind === "diff") return dot("var(--state-info)");
  if (tab.kind === "project-settings") return dot("var(--accent)");
  return dot("var(--state-warning)");
}

/* ------------------------------------------------------------------
   Tab content router
   ------------------------------------------------------------------ */

function TabContent({
  worktree,
  tab,
  projectPath,
}: {
  worktree: Worktree;
  tab: Tab | null;
  projectPath: string;
}) {
  if (!tab) {
    return (
      <div
        style={{
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-xs)",
        }}
      >
        No tab open. Press <Kbd>+</Kbd> to start a terminal.
      </div>
    );
  }

  return (
    <div style={{ minHeight: 0, position: "relative", overflow: "hidden" }}>
      <ErrorBoundary>
        {tab.kind === "terminal" ? (
          // `key={tab.id}` forces a fresh BlockTerminal per tab. Without it,
          // React reuses the same instance across tab switches and the
          // child's local state (`foregroundIsAgent`, `activeCommand`,
          // `altScreen`, …) leaks from the previous tab — which is how a
          // new tab opened while another tab is running claude inherits
          // `foregroundIsAgent=true` and the PromptInput never renders.
          // The PTY itself survives unmount (useTerminalSession explicitly
          // skips `term_close` on teardown), so the cost of remounting is
          // a `term_start` re-emit of the cached grid — cheap and idempotent.
          <TerminalTabContent key={tab.id} worktree={worktree} tab={tab} />
        ) : tab.kind === "diff" ? (
          <DiffTabContent
            key={tab.id}
            projectPath={projectPath}
            filePath={tab.filePath}
            staged={tab.staged}
          />
        ) : tab.kind === "project-settings" ? (
          <RepositorySettingsView key={tab.id} projectId={tab.projectId} />
        ) : (
          <MarkdownTabContent key={tab.id} tab={tab} />
        )}
      </ErrorBoundary>
    </div>
  );
}

function TerminalTabContent({
  worktree,
  tab,
}: {
  worktree: Worktree;
  tab: TerminalTab;
}) {
  const dispatch = useAppDispatch();
  const { settings } = useAppState();
  return (
    <BlockTerminal
      id={tab.ptyId}
      command="zsh"
      cwd={worktree.path}
      autoSummarize={settings.autoSummarize}
      projectId={worktree.projectId}
      sessionId={worktree.id}
      // Re-seed agent state on remount so an in-flight claude/codex
      // session doesn't briefly drop back to shell mode (which paints
      // PromptInput under the agent's own UI) when the user navigates
      // back to the tab.
      initialAgentRunning={tab.agentStatus === "running"}
      initialAgentCli={tab.detectedCli}
      onAgentRunningChange={(running, cli) => {
        dispatch({
          type: "update-tab",
          id: tab.id,
          patch: {
            agentStatus: running ? "running" : "idle",
            detectedCli: cli ?? null,
          },
        });
        dispatch({
          type: "set-agent-status",
          worktreeId: worktree.id,
          status: running ? "running" : "idle",
          cli: cli ?? worktree.agentCli,
        });
        // Settings-driven side effects on running→idle transition.
        if (!running && tab.agentStatus === "running") {
          if (settings.notifyOnIdle) {
            void notifyAgentFinished(worktree.name, tab.title);
          }
          if (settings.completionSound !== "none") {
            playCompletionSound(settings.completionSound);
          }
        }
      }}
      onActivitySummaryChange={(summary) => {
        if (!summary) return;
        dispatch({ type: "set-tab-summary", id: tab.id, summary });
        const isPlaceholder =
          tab.title === "Untitled" || tab.title === "main" || tab.title === "";
        if (isPlaceholder) {
          const derived = summary
            .replace(/\s+/g, " ")
            .trim()
            .split(" ")
            .slice(0, 5)
            .join(" ")
            .slice(0, 40);
          // Skip the bare-launch-command case: when the activity
          // source is just "claude" / "codex" / "gemini" (the user
          // typed the agent's name and the AI summarizer hasn't
          // produced a real activity line yet), promoting that into
          // tab.title pollutes the title with the agent's name. The
          // tab strip already shows the CLI badge via tabLabel while
          // the agent runs, so we don't need it duplicated in the
          // underlying title — and once the agent exits we'd be
          // stuck with "claude" as the persistent title forever.
          const looksLikeBareCli =
            /^(claude(-code)?|codex(-cli)?|gemini(-cli)?|aider)$/i.test(derived);
          if (derived && !looksLikeBareCli) {
            dispatch({
              type: "update-tab",
              id: tab.id,
              patch: { title: derived },
            });
          }
        }
      }}
    />
  );
}

/**
 * Fire a macOS notification via the standard Web API. Tauri's WKWebView
 * forwards `Notification` to NSUserNotification when the bundle is
 * properly entitled; otherwise this is a silent no-op.
 */
async function notifyAgentFinished(worktreeName: string, tabTitle: string) {
  if (typeof Notification === "undefined") return;
  try {
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    new Notification(`${worktreeName} · agent idle`, {
      body: tabTitle,
      tag: `rli-agent-idle-${worktreeName}-${tabTitle}`,
    });
  } catch {
    // Best-effort; notifications are nice-to-have.
  }
}

let cachedAudio: HTMLAudioElement | null = null;
function playCompletionSound(kind: "subtle" | "bell") {
  // Generate an inline tone via WebAudio so we don't ship audio assets.
  // `subtle` = a single short blip; `bell` = a quick two-note chime.
  try {
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const now = ctx.currentTime;
    const tones = kind === "subtle" ? [{ f: 880, t: 0, d: 0.12 }] : [
      { f: 880, t: 0, d: 0.12 },
      { f: 660, t: 0.14, d: 0.18 },
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.f;
      gain.gain.setValueAtTime(0.0001, now + tone.t);
      gain.gain.exponentialRampToValueAtTime(0.18, now + tone.t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.t + tone.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + tone.t);
      osc.stop(now + tone.t + tone.d + 0.01);
    }
  } catch {
    void cachedAudio;
  }
}

function DiffTabContent({
  projectPath,
  filePath,
  staged,
}: {
  projectPath: string;
  filePath: string;
  staged: boolean;
}) {
  return (
    <DiffView
      projectPath={projectPath}
      filePath={filePath}
      staged={staged}
      onClose={() => {
        /* main-column DiffView is embedded; close handled via tab close */
      }}
    />
  );
}

function MarkdownTabContent({ tab }: { tab: Tab & { kind: "markdown" } }) {
  const dispatch = useAppDispatch();
  const lastReadRef = useRef<string | null>(null);

  useEffect(() => {
    if (tab.content !== null) return;
    if (lastReadRef.current === tab.filePath) return;
    lastReadRef.current = tab.filePath;
    void fs
      .readTextFile(tab.filePath)
      .then((content) => {
        dispatch({ type: "update-tab", id: tab.id, patch: { content } });
      })
      .catch(() => {
        dispatch({
          type: "update-tab",
          id: tab.id,
          patch: { content: "" },
        });
      });
  }, [tab.id, tab.filePath, tab.content, dispatch]);

  return (
    <Editor
      path={tab.filePath}
      content={tab.content ?? ""}
      onChange={(content) => {
        dispatch({ type: "update-tab", id: tab.id, patch: { content } });
      }}
    />
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        margin: "0 4px",
        backgroundColor: "var(--surface-3)",
        border: "var(--border-1)",
        borderRadius: "var(--radius-xs)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </kbd>
  );
}

