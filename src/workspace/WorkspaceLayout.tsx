import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { Editor } from "@/editor/Editor";
import { BrowserPane } from "@/browser/BrowserPane";
import { GraphView } from "@/graph/GraphView";
import { useActiveProject, useActiveSession, useAppDispatch } from "@/state/AppState";
import type { PaneContent, PaneNode, PaneNodeId, SessionId } from "@/state/types";
import { PaneFrame } from "./PaneFrame";
import { PaneDragProvider } from "./PaneDragContext";

interface Props {
  /** Total leaf count in the tree — used so the close button is hidden when only one pane exists. */
  totalLeaves: number;
  node: PaneNode;
}

/**
 * Recursive renderer for the workspace pane tree. Splits become nested
 * <PanelGroup>s; leaves become <PaneFrame>s wrapping the right content
 * (terminal / editor / browser).
 *
 * Sizes aren't persisted yet — react-resizable-panels uses an autoSaveId
 * keyed off the split id so each split's drag-position survives reloads
 * within a single session.
 */
export function WorkspaceLayout({ node, totalLeaves }: Props) {
  return (
    <PaneDragProvider>
      <PaneNodeRenderer node={node} totalLeaves={totalLeaves} />
    </PaneDragProvider>
  );
}

function PaneNodeRenderer({ node, totalLeaves }: Props) {
  const session = useActiveSession();
  const openFile = session?.openFile ?? null;

  if (node.kind === "leaf") {
    return (
      <PaneFrame
        paneId={node.id}
        content={node.content}
        isOnly={totalLeaves === 1}
        subtitle={paneSubtitle(node.content, {
          sessionSubtitle: session?.subtitle,
          openFilePath: openFile?.path ?? null,
        })}
      >
        <PaneBody paneId={node.id} content={node.content} />
      </PaneFrame>
    );
  }
  return (
    <PanelGroup
      direction={node.direction}
      autoSaveId={`workspace-${node.id}`}
    >
      <Panel defaultSize={50} minSize={15}>
        <PaneNodeRenderer node={node.children[0]} totalLeaves={totalLeaves} />
      </Panel>
      <PanelResizeHandle />
      <Panel defaultSize={50} minSize={15}>
        <PaneNodeRenderer node={node.children[1]} totalLeaves={totalLeaves} />
      </Panel>
    </PanelGroup>
  );
}

function paneSubtitle(
  content: PaneContent,
  ctx: { sessionSubtitle?: string; openFilePath: string | null },
): string | undefined {
  if (content === "terminal") return ctx.sessionSubtitle?.trim() || undefined;
  if (content === "editor") {
    if (!ctx.openFilePath) return undefined;
    const parts = ctx.openFilePath.split("/").filter(Boolean);
    return parts[parts.length - 1];
  }
  return undefined;
}

function PaneBody({
  paneId,
  content,
}: {
  paneId: PaneNodeId;
  content: PaneContent;
}) {
  if (content === "terminal") return <TerminalBody paneId={paneId} />;
  if (content === "editor") return <EditorBody />;
  if (content === "graph") return <GraphView />;
  return <BrowserBody />;
}

function TerminalBody({ paneId }: { paneId: PaneNodeId }) {
  const project = useActiveProject();
  const session = useActiveSession();
  const dispatch = useAppDispatch();
  // First terminal pane uses the active session's terminal; subsequent
  // terminal panes get their own ephemeral session ids derived from pane
  // ids so each terminal pane runs an independent shell.
  const ptyId: SessionId = session ? `agent-${session.id}-${paneId}` : `agent-${paneId}`;
  if (!project) return <Empty label="open a project — ⌘O" />;
  return (
    <BlockTerminal
      key={ptyId}
      id={ptyId}
      command="zsh"
      args={["-l"]}
      cwd={project.path}
      projectId={project.id}
      sessionId={session?.id}
      onClaudeDetected={
        session
          ? (timestamp) =>
              dispatch({
                type: "update-session",
                id: session.id,
                patch: { claudeStartedAt: timestamp },
              })
          : undefined
      }
      onActivitySummaryChange={
        session
          ? (summary) =>
              dispatch({
                type: "update-session",
                id: session.id,
                patch: { subtitle: summary },
              })
          : undefined
      }
      onAgentRunningChange={
        session
          ? (running) =>
              dispatch({
                type: "update-session",
                id: session.id,
                patch: { agentRunning: running },
              })
          : undefined
      }
    />
  );
}

function EditorBody() {
  const session = useActiveSession();
  const dispatch = useAppDispatch();
  const openFile = session?.openFile ?? null;
  if (!openFile || !session) {
    return <Empty label="click a file in the tree to open it" />;
  }
  return (
    <Editor
      key={`${session.id}-${openFile.path}`}
      path={openFile.path}
      content={openFile.content}
      onChange={(content) =>
        dispatch({
          type: "open-file",
          sessionId: session.id,
          file: { path: openFile.path, content },
        })
      }
    />
  );
}

function BrowserBody() {
  // Closing is handled by PaneFrame's × — BrowserPane just renders
  // its content.
  return <BrowserPane embedded onClose={() => {}} />;
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--text-tertiary)",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}
