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
    const id = `t_${Date.now().toString(36)}`;
    const ptyId = `pty_${id}`;
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
        gap: 6,
        height: 32,
        minWidth: 100,
        maxWidth: 220,
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
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: "var(--text-base)",
          fontWeight: "var(--weight-medium)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {tabLabel(tab)}
      </span>
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

/** Bare label for a tab — bare names only (no path, no subtitle).
 *  Terminal tabs that have detected an agent show the CLI name. */
function tabLabel(tab: Tab): string {
  if (tab.kind === "terminal") {
    return tab.detectedCli ?? tab.title ?? "shell";
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
          <TerminalTabContent worktree={worktree} tab={tab} />
        ) : tab.kind === "diff" ? (
          <DiffTabContent
            projectPath={projectPath}
            filePath={tab.filePath}
            staged={tab.staged}
          />
        ) : tab.kind === "project-settings" ? (
          <RepositorySettingsView projectId={tab.projectId} />
        ) : (
          <MarkdownTabContent tab={tab} />
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
          if (derived) {
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

