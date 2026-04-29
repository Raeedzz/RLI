import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { BlockTerminal } from "@/terminal/BlockTerminal";
import { Editor } from "@/editor/Editor";
import { BinaryView } from "@/editor/BinaryView";
import { MarkdownView } from "@/editor/MarkdownView";
import { MarkdownToggle } from "@/editor/MarkdownToggle";
import { fileKind } from "@/lib/fileKind";
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
    // Render the Rich/Source toggle inline in the pane header — but
    // ONLY when this pane is the editor AND it's looking at a .md
    // file. For everything else (terminal, browser, .ts/.py/.rs in
    // the editor) the slot is left empty.
    const headerActions =
      node.content === "editor" && openFile && isMarkdown(openFile.path) ? (
        <MarkdownToggle />
      ) : undefined;
    return (
      <PaneFrame
        paneId={node.id}
        content={node.content}
        isOnly={totalLeaves === 1}
        subtitle={paneSubtitle(node.content, {
          sessionSubtitle: session?.subtitle,
          openFilePath: openFile?.path ?? null,
        })}
        headerActions={headerActions}
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
      <PanelResizeHandle
        tabIndex={-1}
        hitAreaMargins={{ coarse: 6, fine: 4 }}
      />
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
  // Images and other binaries render in a dedicated viewer instead of
  // CodeMirror — opening a 4 MB PNG as text was the original "garbage
  // bytes corrupted the icon" bug. The text content is empty for these
  // kinds (the open-file flow never read the file as a string), so the
  // viewer reads from disk via the asset:// protocol.
  if (fileKind(openFile.path) !== "text") {
    return (
      <BinaryView
        key={`${session.id}-${openFile.path}`}
        path={openFile.path}
      />
    );
  }
  // Markdown gets a rich-preview view that defaults to rendered HTML
  // and exposes a Preview / Source toggle in the header. The Source
  // tab drops back to the same CodeMirror editor every other text
  // file uses.
  if (isMarkdown(openFile.path)) {
    return (
      <MarkdownView
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

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
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
