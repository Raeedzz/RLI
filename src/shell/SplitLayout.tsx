import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Pane } from "./Pane";
import { FileTree } from "@/files/FileTree";
import { FileContextMenu } from "@/files/FileContextMenu";
import { GitPanel } from "@/git/GitPanel";
import { DiffView } from "@/git/DiffView";
import { ConnectionsPanel } from "@/connections/ConnectionsPanel";
import { TopBar } from "./TopBar";
import { fs } from "@/lib/fs";
import { fileKind, isBinaryPath } from "@/lib/fileKind";
import {
  useActiveProject,
  useActiveSession,
  useAppDispatch,
  useAppState,
} from "@/state/AppState";
import { WorkspaceLayout } from "@/workspace/WorkspaceLayout";
import { leaves } from "@/state/paneTree";

/**
 * Two-column workspace — file tree on the left, panes on the right:
 *
 *   ┌────────┬────────────────────────────────────────┐
 *   │ files  │  active session's pane tree            │
 *   │        │  (terminals / editors / browsers)      │
 *   └────────┴────────────────────────────────────────┘
 *
 * Each session owns its own pane tree (`session.workspace`) and its
 * own open file (`session.openFile`). Switching sessions swaps the
 * entire workspace — different splits, different files, different
 * terminals. PTYs and editor instances unmount on switch (terminal
 * scrollback is lost; layout + open-file path persist via state).
 *
 * Editor changes are autosaved to disk after a 500ms idle.
 */

interface ContextMenuState {
  path: string;
  isDir: boolean;
  anchor: { x: number; y: number };
}

const AUTOSAVE_DEBOUNCE_MS = 500;
/**
 * In dev (Vite + Tauri), every disk write to the project tree
 * triggers an HMR full-reload that visibly jitters the app. Switch
 * to manual save (Cmd+S) in dev so the user can keep typing without
 * the page reloading mid-edit. Production builds keep the
 * keystroke-debounced autosave.
 */
const AUTOSAVE_ENABLED = !import.meta.env.DEV;

// Binary files (images, archives, audio…) never autosave — round-tripping
// bytes through CodeMirror as UTF-8 would corrupt them. We piggy-back on
// the same kind classifier the editor pane uses to pick its viewer
// (`@/lib/fileKind`) so the two stay in sync.

export function SplitLayout() {
  const project = useActiveProject();
  const session = useActiveSession();
  const { leftPanel } = useAppState();
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [diffFile, setDiffFile] = useState<{
    path: string;
    staged: boolean;
  } | null>(null);
  // Tracks the content most recently read from disk for the open file —
  // we suppress the autosave kick-off when in-memory content matches.
  const lastSavedRef = useRef<{ path: string; content: string } | null>(null);

  const workspace = session?.workspace;
  const openFile = session?.openFile ?? null;
  const totalLeaves = workspace ? leaves(workspace).length : 0;

  // Autosave — debounce disk writes so we don't thrash on every
  // keystroke. Disabled in dev mode (Vite picks up the writes and
  // does a full-reload that visibly jitters the app between every
  // keystroke). Cmd+S still saves manually in dev.
  useEffect(() => {
    if (!AUTOSAVE_ENABLED) return;
    if (!openFile) return;
    if (isBinaryPath(openFile.path)) return;
    const last = lastSavedRef.current;
    if (last && last.path === openFile.path && last.content === openFile.content) {
      return;
    }
    // First time we see this path on this mount — could be a click
    // through `onOpenFile` (which primes `lastSavedRef` first, so we
    // never reach here) OR a hydration from persisted state (where the
    // ref is still null). In the hydration case the in-memory content
    // was already on disk; writing it back would just touch the file's
    // mtime and trigger a Vite reload loop. Prime the ref and bail —
    // the next *real* change will trip the equality check below and
    // schedule a write.
    if (!last || last.path !== openFile.path) {
      lastSavedRef.current = {
        path: openFile.path,
        content: openFile.content,
      };
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

  // Cmd+S manual save — works in both dev and prod. In dev this is
  // the only save mechanism; in prod it's a backup to autosave.
  useEffect(() => {
    if (!openFile) return;
    if (isBinaryPath(openFile.path)) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const f = openFile;
        if (!f) return;
        void fs
          .writeTextFile(f.path, f.content)
          .then(() => {
            lastSavedRef.current = { path: f.path, content: f.content };
          })
          .catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile?.path, openFile?.content]);

  // When the user switches sessions, reset the autosave watermark so the
  // next file open in the new session triggers a fresh load comparison.
  // Also drop any open diff overlay so it doesn't ghost across sessions.
  useEffect(() => {
    lastSavedRef.current = null;
    setDiffFile(null);
  }, [session?.id]);

  const onOpenFile = async (path: string) => {
    if (!session) return;
    // If the workspace has no editor pane, split the rightmost leaf
    // right with editor content so the file opens next to the
    // terminal automatically. Closing the editor and clicking another
    // file in the tree re-opens it the same way.
    const allLeaves = leaves(session.workspace);
    const hasEditor = allLeaves.some((l) => l.content === "editor");
    if (!hasEditor && allLeaves.length > 0) {
      dispatch({
        type: "split-pane",
        sessionId: session.id,
        paneId: allLeaves[allLeaves.length - 1].id,
        direction: "right",
        content: "editor",
      });
    }
    // Binaries (images, archives, audio, etc.) — don't try to round-trip
    // bytes through readTextFile. The editor pane decides how to render
    // each kind based on the path extension. We still dispatch the
    // open-file action so the editor knows which file to show; the
    // content is just an empty string for non-text files.
    const kind = fileKind(path);
    if (kind !== "text") {
      lastSavedRef.current = { path, content: "" };
      dispatch({
        type: "open-file",
        sessionId: session.id,
        file: { path, content: "" },
      });
      return;
    }
    try {
      const content = await fs.readTextFile(path);
      lastSavedRef.current = { path, content };
      dispatch({
        type: "open-file",
        sessionId: session.id,
        file: { path, content },
      });
    } catch (err) {
      // Surface as a read-only inline message. CRITICAL: prime
      // `lastSavedRef` with the same synthetic content so the autosave
      // effect sees "no diff vs disk" and doesn't write the error
      // message back to the file. (This is what corrupted icon-128.png
      // when the user clicked it earlier.)
      const synthetic = `// could not read file: ${String(err)}`;
      lastSavedRef.current = { path, content: synthetic };
      dispatch({
        type: "open-file",
        sessionId: session.id,
        file: { path, content: synthetic },
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
    return (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <TopBar />
        <PaneStub label="open a project — ⌘O" />
      </div>
    );
  }
  if (!session || !workspace) {
    return (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <TopBar />
        <PaneStub label="no active session — press ⌘N" />
      </div>
    );
  }

  return (
    <>
      {/* Bump autoSaveId whenever the panel order or default sizes
          change so the persisted left/right sizes don't get resurrected
          with the wrong slot or an obsolete width. */}
      <PanelGroup direction="horizontal" autoSaveId="rli-workspace-v9">
        {leftPanel !== null && (
          <>
            <Panel
              // 20% lands the divider in a sweet spot: enough room for
              // typical file names without pushing the workspace
              // column too far right. Wider was visibly cramped on the
              // workspace side; narrower clipped file names.
              defaultSize={20}
              minSize={14}
              maxSize={32}
              order={1}
              collapsible
            >
              <Pane surface="1">
                {leftPanel === "files" && (
                  <FileTreePane
                    projectPath={project.path}
                    openFilePath={openFile?.path ?? null}
                    onOpenFile={onOpenFile}
                    onContextMenu={onFileContextMenu}
                  />
                )}
                {leftPanel === "git" && (
                  <GitPanel
                    projectPath={project.path}
                    selectedPath={diffFile?.path ?? null}
                    onOpenDiff={(path, staged) =>
                      setDiffFile({ path, staged })
                    }
                  />
                )}
                {leftPanel === "connections" && (
                  <ConnectionsPanel projectPath={project.path} />
                )}
              </Pane>
            </Panel>
            <PanelResizeHandle
              tabIndex={-1}
              // Visible line stays a hairline; only the hit zone is
              // expanded a touch so the user can still grab the divider
              // precisely without the line jittering or visibly widening.
              hitAreaMargins={{ coarse: 6, fine: 4 }}
            />
          </>
        )}

        {/* Dynamic workspace column — tabs row pinned at top, then a
            splittable / draggable / swappable pane tree below it.
            Tabs only span this column (not the full window) so the
            sidebar above gets to start at the chrome line. */}
        <Panel defaultSize={82} minSize={30} order={2}>
          <div
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              backgroundColor: "var(--surface-1)",
            }}
          >
            <TopBar />
            <div
              // Keying on session.id forces React to fully unmount the
              // previous session's workspace tree (and its PTYs / editor
              // state) when switching sessions — keeping each session's
              // setup isolated.
              key={session.id}
              style={{
                flex: 1,
                minHeight: 0,
                position: "relative",
                // Panes go edge-to-edge — no inner gutter. Pane bodies
                // abut the resize handles directly so the dividers are
                // continuous 1px lines from top to bottom of the column,
                // not segments separated by gaps. Cleaner and lines up
                // exactly with the file panel divider on the left.
                padding: 0,
                backgroundColor: "var(--surface-1)",
              }}
            >
              <WorkspaceLayout node={workspace} totalLeaves={totalLeaves} />
              <AnimatePresence>
                {diffFile && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 5,
                    }}
                  >
                    <DiffView
                      projectPath={project.path}
                      filePath={diffFile.path}
                      staged={diffFile.staged}
                      onClose={() => setDiffFile(null)}
                    />
                  </div>
                )}
              </AnimatePresence>
            </div>
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
          padding: "0 var(--space-2)",
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

