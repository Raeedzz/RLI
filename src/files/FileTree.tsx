import { useCallback, useEffect, useState } from "react";
import { fs, type DirEntry } from "@/lib/fs";
import {
  statusVisual,
  useGitStatus,
  type GitStatusMap,
} from "@/hooks/useGitStatus";
import { FileTypeIcon, fileTypeFor } from "./FileTypeIcon";

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  onContextMenu?: (
    path: string,
    isDir: boolean,
    e: React.MouseEvent,
  ) => void;
  activeFile?: string | null;
}

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  /** undefined = not loaded yet, [] = loaded but empty */
  children?: Node[];
  expanded: boolean;
}

const INDENT = 12;
const ROW_HEIGHT = 22;

/**
 * Lazy file tree. Reads entries via the Rust `fs_read_dir` command,
 * which already filters out node_modules / target / .git / dist /
 * .rli session worktrees. Click a file to open it in the editor;
 * click a folder to expand.
 *
 * Custom-rolled rather than react-arborist because our needs are
 * minimal (read-only, single-select) and we want full control over
 * the row chrome.
 */
export function FileTree({
  root,
  onOpenFile,
  onContextMenu,
  activeFile,
}: Props) {
  const [tree, setTree] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gitStatus = useGitStatus(root);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    fs.readDir(root)
      .then((entries) => {
        if (cancelled) return;
        setTree({
          name: basename(root),
          path: root,
          isDir: true,
          expanded: true,
          children: entries.map(toNode),
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const toggle = useCallback(async (node: Node) => {
    if (!node.isDir) return;
    if (node.children === undefined) {
      try {
        const entries = await fs.readDir(node.path);
        node.children = entries.map(toNode);
      } catch {
        node.children = [];
      }
    }
    node.expanded = !node.expanded;
    // Force re-render by replacing the tree root reference.
    setTree((prev) => (prev ? { ...prev } : prev));
  }, []);

  if (error) {
    return (
      <div
        style={{
          padding: "var(--space-4)",
          color: "var(--state-error)",
          fontSize: "var(--text-xs)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {error}
      </div>
    );
  }

  if (!tree) {
    return (
      <div
        style={{
          padding: "var(--space-4)",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-xs)",
        }}
      >
        loading…
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        padding: "var(--space-1) 0",
      }}
    >
      {tree.children?.map((child) => (
        <RowSubtree
          key={child.path}
          node={child}
          depth={0}
          onToggle={toggle}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
          activeFile={activeFile ?? null}
          gitStatus={gitStatus}
        />
      ))}
    </div>
  );
}

function RowSubtree({
  node,
  depth,
  onToggle,
  onOpenFile,
  onContextMenu,
  activeFile,
  gitStatus,
}: {
  node: Node;
  depth: number;
  onToggle: (n: Node) => void;
  onOpenFile: (path: string) => void;
  onContextMenu?: (
    path: string,
    isDir: boolean,
    e: React.MouseEvent,
  ) => void;
  activeFile: string | null;
  gitStatus: GitStatusMap;
}) {
  return (
    <>
      <Row
        node={node}
        depth={depth}
        active={!node.isDir && node.path === activeFile}
        gitStatus={gitStatus}
        onClick={() => {
          if (node.isDir) onToggle(node);
          else onOpenFile(node.path);
        }}
        onContextMenu={
          onContextMenu
            ? (e) => onContextMenu(node.path, node.isDir, e)
            : undefined
        }
      />
      {node.isDir &&
        node.expanded &&
        node.children?.map((child) => (
          <RowSubtree
            key={child.path}
            node={child}
            depth={depth + 1}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            activeFile={activeFile}
            gitStatus={gitStatus}
          />
        ))}
    </>
  );
}

function Row({
  node,
  depth,
  active,
  gitStatus,
  onClick,
  onContextMenu,
}: {
  node: Node;
  depth: number;
  active: boolean;
  gitStatus: GitStatusMap;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const statusEntry = node.isDir ? undefined : gitStatus.get(node.path);
  const visual = statusVisual(statusEntry);
  // Tint each filename with its file-type pigment so a glance at the
  // tree distinguishes Cargo.toml (rust) from package.json (amber) from
  // Dockerfile (slate) without needing to read the icon. Git status
  // takes priority — added/modified/deleted should still pop.
  const typeColor = !node.isDir ? fileTypeFor(node.name).color : null;
  const nameColor = active
    ? "var(--text-primary)"
    : (visual?.color ?? typeColor ?? "var(--text-secondary)");
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          onContextMenu(e);
        }
      }}
      title={node.path}
      style={{
        width: "100%",
        height: ROW_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth * INDENT + 8,
        paddingRight: 8,
        gap: 6,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
        color: active
          ? "var(--text-primary)"
          : node.isDir
            ? "var(--text-secondary)"
            : "var(--text-secondary)",
        backgroundColor: active ? "var(--surface-2)" : "transparent",
        textAlign: "left",
        cursor: "default",
        transition:
          "background-color var(--motion-instant) var(--ease-out-quart)",
      }}
      onMouseEnter={(e) => {
        if (!active)
          e.currentTarget.style.backgroundColor = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <span
        style={{
          width: 8,
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          opacity: node.isDir ? 0.7 : 0,
        }}
        aria-hidden
      >
        {node.isDir ? (node.expanded ? "▾" : "▸") : ""}
      </span>
      <FileTypeIcon name={node.name} isDir={node.isDir} open={node.expanded} />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: node.isDir
            ? "var(--weight-medium)"
            : "var(--weight-regular)",
          color: nameColor,
        }}
      >
        {node.name}
      </span>
      {visual && (
        <span
          aria-label={visual.label}
          title={visual.label}
          style={{
            flexShrink: 0,
            width: 12,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: "var(--weight-semibold)",
            color: visual.color,
            letterSpacing: "-0.04em",
          }}
        >
          {visual.badge}
        </span>
      )}
    </button>
  );
}

function toNode(e: DirEntry): Node {
  return {
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
    expanded: false,
  };
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}
