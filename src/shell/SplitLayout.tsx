import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Pane } from "./Pane";
import { FileTree } from "@/files/FileTree";
import { FileContextMenu } from "@/files/FileContextMenu";
import { fs } from "@/lib/fs";
import {
  useActiveProject,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { WorkspaceLayout } from "@/workspace/WorkspaceLayout";
import { leaves } from "@/state/paneTree";

/**
 * Three-column workspace:
 *
 *   ┌────────┬────────────────────┬──────────────────┐
 *   │ files  │  terminal          │  editor          │
 *   │        │  (claude/zsh)      │  (active file)   │
 *   └────────┴────────────────────┴──────────────────┘
 *
 * Terminal sits in the middle so the agent's stream of work stays
 * front-and-center — the editor is reference; what the agent is doing
 * is the focus. File tree on the left reads the active project live;
 * right-clicking a file opens a menu to reveal in Finder / open in
 * VS Code / Cursor / Sublime / browser.
 *
 * Editor changes are autosaved to disk after a 500ms idle.
 */

interface ContextMenuState {
  path: string;
  isDir: boolean;
  anchor: { x: number; y: number };
}

const AUTOSAVE_DEBOUNCE_MS = 500;

export function SplitLayout() {
  const project = useActiveProject();
  const { fileTreeVisible, openFile, workspace } = useAppState();
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Tracks the content most recently read from disk for the open file —
  // we suppress the autosave kick-off when in-memory content matches.
  const lastSavedRef = useRef<{ path: string; content: string } | null>(null);
  const totalLeaves = leaves(workspace).length;

  // Close the open file when projects change so we don't render content
  // from a different repo.
  useEffect(() => {
    dispatch({ type: "close-file" });
  }, [project?.id, dispatch]);

  // Autosave — debounce disk writes so we don't thrash on every keystroke.
  useEffect(() => {
    if (!openFile) return;
    const last = lastSavedRef.current;
    if (last && last.path === openFile.path && last.content === openFile.content) {
      return;
    }
    const timer = window.setTimeout(() => {
      fs.writeTextFile(openFile.path, openFile.content)
        .then(() => {
          lastSavedRef.current = {
            path: openFile.path,
            content: openFile.content,
          };
        })
        .catch(() => {
          // Disk write failed (permissions, file vanished, etc.) — silent
          // for now. A toast will land when we have toast infra wired up.
        });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [openFile?.path, openFile?.content]);

  const onOpenFile = async (path: string) => {
    try {
      const content = await fs.readTextFile(path);
      lastSavedRef.current = { path, content };
      dispatch({ type: "open-file", file: { path, content } });
    } catch (err) {
      // Surface as a "binary or too large" inline message in the editor pane
      dispatch({
        type: "open-file",
        file: {
          path,
          content: `// could not read file: ${String(err)}`,
        },
      });
    }
  };

  const onFileContextMenu = (
    path: string,
    isDir: boolean,
    e: MouseEvent,
  ) => {
    setMenu({ path, isDir, anchor: { x: e.clientX, y: e.clientY } });
  };

  if (!project) {
    return <PaneStub label="open a project — ⌘O" />;
  }

  return (
    <>
      <PanelGroup direction="horizontal" autoSaveId="rli-workspace-v3">
        {fileTreeVisible && (
          <>
            <Panel
              defaultSize={18}
              minSize={12}
              maxSize={32}
              order={1}
              collapsible
            >
              <Pane surface="1">
                <FileTreePane
                  projectPath={project.path}
                  openFilePath={openFile?.path ?? null}
                  onOpenFile={onOpenFile}
                  onContextMenu={onFileContextMenu}
                />
              </Pane>
            </Panel>
            <PanelResizeHandle />
          </>
        )}

        {/* Dynamic workspace — splittable, draggable, swappable panes.
            Padding here paints surface-1 in the gutters between panes
            and around the workspace edge. */}
        <Panel defaultSize={82} minSize={30} order={2}>
          <div
            style={{
              height: "100%",
              width: "100%",
              padding: "var(--space-2)",
              backgroundColor: "var(--surface-1)",
            }}
          >
            <WorkspaceLayout node={workspace} totalLeaves={totalLeaves} />
          </div>
        </Panel>
      </PanelGroup>

      <AnimatePresence>
        {menu && (
          <FileContextMenu
            path={menu.path}
            isDir={menu.isDir}
            anchor={menu.anchor}
            onOpenInEditor={() => {
              setMenu(null);
              if (!menu.isDir) void onOpenFile(menu.path);
            }}
            onClose={() => setMenu(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function FileTreePane({
  projectPath,
  openFilePath,
  onOpenFile,
  onContextMenu,
}: {
  projectPath: string;
  openFilePath: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (path: string, isDir: boolean, e: MouseEvent) => void;
}) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--surface-1)",
      }}
    >
      <div
        style={{
          height: "var(--pane-header-height)",
          display: "flex",
          alignItems: "center",
          padding: "0 var(--space-3)",
          borderBottom: "var(--border-1)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-caps)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        files
      </div>
      <FileTree
        root={projectPath}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        activeFile={openFilePath}
      />
    </div>
  );
}

function PaneStub({ label }: { label: string }) {
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

