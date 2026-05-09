import { useEffect, useRef, useState } from "react";
import {
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { cm6ThemeExtension } from "@/design/cm6-theme";
import { AskCard } from "./AskCard";

interface Props {
  /** Path the file came from — purely metadata used for the ask system prompt. */
  path?: string;
  /** Initial content. */
  content: string;
  /** Called when the user edits. */
  onChange?: (content: string) => void;
}

interface AskState {
  selection: string;
  context: string;
  pathHint?: string;
  /** Top of the selection, in viewport coords — used to anchor the card. */
  anchorTop: number;
  /** Right edge of the editor in viewport coords — anchor's left edge. */
  anchorLeft: number;
}

interface AskHintState {
  /** Selection rectangle (viewport coords). */
  top: number;
  left: number;
}

/**
 * CodeMirror 6 editor with RLI's calm syntax theme + the ⌘L
 * highlight-and-ask command.
 *
 * ⌘L while focused with a non-empty selection captures the selection
 * + 30 lines of context above and below, sends it to Gemini Flash-Lite
 * via the AskCard, and shows the answer in a margin annotation. Esc
 * dismisses.
 *
 * Languages auto-detected from file extension. v1 ships JS/TS + Rust;
 * adding more is one import each.
 */
export function Editor({ path, content, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [askHint, setAskHint] = useState<AskHintState | null>(null);

  const openAsk = (
    selection: string,
    context: string,
    anchorTop: number,
    anchorLeft: number,
  ) => {
    setAsk({
      selection,
      context,
      pathHint: path,
      anchorTop,
      anchorLeft,
    });
    setAskHint(null);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const langExt = languageFor(path);
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      indentOnInput(),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        {
          key: "Mod-l",
          preventDefault: true,
          run: (view) => {
            const sel = view.state.sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to,
            );
            if (!sel.trim()) return false;
            const context = sliceContext(view, 30);
            const selFrom = view.state.selection.main.from;
            const lineTop = view.coordsAtPos(selFrom);
            const editorRect = view.dom.getBoundingClientRect();
            openAsk(
              sel,
              context,
              lineTop?.top ?? editorRect.top + 60,
              editorRect.right - 12,
            );
            return true;
          },
        },
      ]),
      // No line wrapping — long lines overflow horizontally and the
      // editor's own scroller scrolls the view. Code (especially logs,
      // long URLs, or wide source files) reads better unwrapped, and
      // the user can decide to soft-wrap by widening the pane instead.
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onChange) {
          onChange(u.state.doc.toString());
        }
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          if (sel.empty) {
            setAskHint(null);
          } else {
            const slice = u.state.sliceDoc(sel.from, sel.to);
            if (slice.trim().length === 0) {
              setAskHint(null);
              return;
            }
            const startCoords = u.view.coordsAtPos(sel.from);
            const endCoords = u.view.coordsAtPos(sel.to);
            if (!startCoords || !endCoords) return;
            // Anchor below the bottom-right of the selection so the hint
            // never blocks what the user just selected.
            setAskHint({
              top: endCoords.bottom + 4,
              left: Math.max(endCoords.right - 90, startCoords.left),
            });
          }
        }
      }),
      ...(langExt ? [langExt] : []),
      ...cm6ThemeExtension,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: container,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally rebuild on path/content change since switching files
    // is fine to recreate. For incremental edits the updateListener handles it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Replace the doc when content changes externally (e.g., file watcher).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content]);

  return (
    <div
      ref={containerRef}
      className="editor-content"
      style={{
        height: "100%",
        width: "100%",
        backgroundColor: "var(--surface-0)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {askHint && !ask && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            const view = viewRef.current;
            if (!view) return;
            const sel = view.state.sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to,
            );
            if (!sel.trim()) return;
            const context = sliceContext(view, 30);
            const selFrom = view.state.selection.main.from;
            const lineTop = view.coordsAtPos(selFrom);
            const editorRect = view.dom.getBoundingClientRect();
            openAsk(
              sel,
              context,
              lineTop?.top ?? editorRect.top + 60,
              editorRect.right - 12,
            );
          }}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "fixed",
            top: askHint.top,
            left: askHint.left,
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-1-5)",
            height: 24,
            padding: "0 var(--space-2) 0 var(--space-2)",
            backgroundColor: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--accent-bright)",
            borderRadius: "var(--radius-pill)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            letterSpacing: "var(--tracking-tight)",
            boxShadow: "var(--shadow-popover)",
            cursor: "default",
            zIndex: "var(--z-tooltip)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-pill)",
              backgroundColor: "var(--accent-bright)",
            }}
          />
          Ask
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              color: "var(--text-tertiary)",
              marginLeft: 2,
            }}
          >
            ⌘L
          </span>
        </button>
      )}
      {ask && (
        <AskCard
          selection={ask.selection}
          context={ask.context}
          pathHint={ask.pathHint}
          anchor={{ top: ask.anchorTop, left: ask.anchorLeft }}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}

function languageFor(path?: string): Extension | null {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "rs":
      return rust();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "py":
    case "pyi":
      return python();
    case "yaml":
    case "yml":
      return yaml();
    default:
      return null;
  }
}

/**
 * Returns the selection plus N lines of context above and below.
 * Trimmed if file is shorter.
 */
function sliceContext(view: EditorView, lines: number): string {
  const doc = view.state.doc;
  const { from, to } = view.state.selection.main;
  const startLine = Math.max(1, doc.lineAt(from).number - lines);
  const endLine = Math.min(doc.lines, doc.lineAt(to).number + lines);
  const start = doc.line(startLine).from;
  const end = doc.line(endLine).to;
  return doc.sliceString(start, end);
}
