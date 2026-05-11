import { useEffect, useRef, useState } from "react";
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
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
  StreamLanguage,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { go } from "@codemirror/lang-go";
// Legacy stream-mode languages — covers TOML, shell, ruby, swift,
// kotlin, scala, lua, perl, dockerfile, properties, ini, r,
// haskell, ocaml, clojure, d, diff, erlang, fortran, groovy,
// julia, octave, pascal, powershell, tcl, vb, verilog, vhdl, etc.
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { kotlin, scala, dart } from "@codemirror/legacy-modes/mode/clike";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { r } from "@codemirror/legacy-modes/mode/r";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { gas } from "@codemirror/legacy-modes/mode/gas";
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica";
import { ttcn } from "@codemirror/legacy-modes/mode/ttcn";
import { oCaml, fSharp, sml } from "@codemirror/legacy-modes/mode/mllike";
import { sas } from "@codemirror/legacy-modes/mode/sas";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { stylus } from "@codemirror/legacy-modes/mode/stylus";
import { cm6ThemeExtension } from "@/design/cm6-theme";
import { AskCard } from "./AskCard";

interface Props {
  /** Path the file came from — purely metadata used for the ask system prompt. */
  path?: string;
  /** Initial content. */
  content: string;
  /** Called when the user edits. */
  onChange?: (content: string) => void;
  /**
   * One-shot navigation target. When set, the editor scrolls to
   * `(line, column)` (1-based) once content is loaded, drops the
   * cursor at that position, and briefly flashes the line. After
   * navigation it self-clears — pass the same value back in on a
   * remount and it'll re-fire; pass `undefined` and it stays put.
   */
  openAt?: { line: number; column: number };
}

// Flash decoration plumbing — drives the `.cm-editor-flash` line
// background animation in tokens.css. Two effects + a single-line
// decoration set: one to add the highlight, one to clear it after
// the animation finishes (so the class doesn't linger and prevent a
// future flash from re-triggering its keyframe).
const setFlashLine = StateEffect.define<number>();
const clearFlashLine = StateEffect.define<void>();

const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setFlashLine)) {
        const lineNum = effect.value;
        if (lineNum >= 1 && lineNum <= tr.state.doc.lines) {
          const line = tr.state.doc.line(lineNum);
          return Decoration.set([
            Decoration.line({
              attributes: { class: "cm-editor-flash" },
            }).range(line.from),
          ]);
        }
      }
      if (effect.is(clearFlashLine)) {
        return Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
export function Editor({ path, content, onChange, openAt }: Props) {
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
      flashLineField,
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

  // Handle one-shot search jumps. Two-phase because the view mounts
  // with empty content on first render, then `content` arrives async
  // from the disk read in MarkdownTabContent. The navigation can only
  // be applied once the doc actually has lines to scroll to, so we
  // watch `content` along with `openAt` and trip the consumed-ref
  // once the doc is non-empty. The MarkdownTabContent layer dispatches
  // a clear of `tab.openAt` on its own mount, so a later tab-switch-
  // and-back doesn't re-fire — `openAt` will be undefined the second
  // time around.
  const consumedOpenAtRef = useRef(false);
  useEffect(() => {
    if (!openAt) return;
    if (consumedOpenAtRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.length === 0) return;

    consumedOpenAtRef.current = true;

    const totalLines = view.state.doc.lines;
    const line = Math.min(Math.max(1, openAt.line), totalLines);
    const lineInfo = view.state.doc.line(line);
    const col = Math.min(Math.max(0, openAt.column - 1), lineInfo.length);
    const pos = lineInfo.from + col;

    view.dispatch({
      selection: { anchor: pos },
      // `scrollIntoView` as an effect (not a property) is what does
      // the actual scroll inside CM6. We center vertically so the
      // matched line lands in the middle of the viewport, not at
      // the edge where it'd be easy to miss.
      effects: [
        EditorView.scrollIntoView(pos, { y: "center" }),
        setFlashLine.of(line),
      ],
    });
    view.focus();

    // Clear the flash decoration after the keyframe animation lands
    // its end state. Keeping the class on the line past that point
    // would prevent a future jump on the same line from re-firing
    // the animation (browsers don't replay completed CSS animations
    // unless the className changes).
    const timer = window.setTimeout(() => {
      view.dispatch({ effects: clearFlashLine.of() });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [content, openAt]);

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
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();

  // Whole-filename matches first — Dockerfile / Makefile / etc.
  // don't have extensions but should still get syntax highlighting.
  if (/^dockerfile(\.|$)/i.test(name)) {
    return StreamLanguage.define(dockerFile);
  }
  if (/^(makefile|gnumakefile|rakefile|gemfile|jenkinsfile|procfile|vagrantfile|brewfile)$/i.test(name)) {
    // No dedicated grammar for these; properties/INI-style highlighter
    // works well enough on the typical key=value lines.
    return StreamLanguage.define(properties);
  }

  const ext = lower.split(".").pop() ?? "";
  switch (ext) {
    // JavaScript / TypeScript
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });

    // Rust
    case "rs":
      return rust();

    // JSON family (tsconfig*, package.json, .eslintrc.json all flow here)
    case "json":
    case "jsonc":
    case "json5":
      return json();

    // TOML — the bit the user specifically called out
    case "toml":
      return StreamLanguage.define(toml);

    // Markdown
    case "md":
    case "mdx":
    case "markdown":
    case "rst":
      return markdown();

    // HTML / templating
    case "html":
    case "htm":
    case "xhtml":
    case "vue":
    case "svelte":
    case "astro":
    case "ejs":
    case "hbs":
    case "handlebars":
    case "mustache":
    case "pug":
    case "jade":
    case "liquid":
    case "twig":
      return html();

    // CSS family
    case "css":
    case "scss":
    case "sass":
    case "less":
    case "pcss":
      return css();
    case "styl":
      return StreamLanguage.define(stylus);

    // Python
    case "py":
    case "pyi":
    case "pyw":
      return python();
    case "ipynb":
      return json();

    // YAML
    case "yaml":
    case "yml":
      return yaml();

    // C family
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hxx":
    case "ino":
    case "m":
    case "mm":
      return cpp();

    // Java / JVM
    case "java":
    case "class":
      return java();
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin);
    case "scala":
    case "sc":
      return StreamLanguage.define(scala);
    case "groovy":
    case "gradle":
      return StreamLanguage.define(groovy);

    // PHP
    case "php":
    case "phtml":
      return php();

    // SQL family
    case "sql":
    case "psql":
    case "mysql":
      return sql();
    case "prisma":
    case "graphql":
    case "gql":
      // No dedicated grammar, but TypeScript-like syntax reads well
      return javascript({ typescript: true });
    case "proto":
      return StreamLanguage.define(protobuf);

    // XML family
    case "xml":
    case "xsd":
    case "xslt":
    case "svg":
    case "rss":
    case "atom":
    case "plist":
    case "csproj":
    case "vbproj":
    case "vcxproj":
      return xml();

    // Go
    case "go":
      return go();

    // Ruby
    case "rb":
    case "rake":
    case "gemspec":
    case "erb":
      return StreamLanguage.define(ruby);

    // Swift
    case "swift":
      return StreamLanguage.define(swift);

    // Lua
    case "lua":
      return StreamLanguage.define(lua);

    // Perl
    case "pl":
    case "pm":
    case "t":
      return StreamLanguage.define(perl);

    // Shell scripts
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
    case "bashrc":
    case "zshrc":
    case "profile":
      return StreamLanguage.define(shell);

    // PowerShell / Windows
    case "ps1":
    case "psm1":
    case "psd1":
      return StreamLanguage.define(powerShell);
    case "bat":
    case "cmd":
      return StreamLanguage.define(shell);
    case "vb":
    case "vba":
      return StreamLanguage.define(vb);
    case "vbs":
      return StreamLanguage.define(vbScript);

    // Statistics / scientific
    case "r":
    case "rmd":
      return StreamLanguage.define(r);
    case "jl":
      return StreamLanguage.define(julia);
    case "octave":
    case "matlab":
      return StreamLanguage.define(octave);
    case "wl":
    case "wls":
    case "nb":
      return StreamLanguage.define(mathematica);
    case "sas":
      return StreamLanguage.define(sas);

    // Functional family
    case "hs":
    case "lhs":
      return StreamLanguage.define(haskell);
    case "erl":
    case "hrl":
      return StreamLanguage.define(erlang);
    case "ex":
    case "exs":
      return StreamLanguage.define(erlang); // close-enough lexing
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return StreamLanguage.define(clojure);
    case "ml":
    case "mli":
      return StreamLanguage.define(oCaml);
    case "fs":
    case "fsx":
    case "fsi":
      return StreamLanguage.define(fSharp);
    case "smlfile":
      return StreamLanguage.define(sml);

    // Systems
    case "f":
    case "f77":
    case "f90":
    case "f95":
    case "for":
      return StreamLanguage.define(fortran);
    case "pas":
    case "pp":
    case "p":
      return StreamLanguage.define(pascal);
    case "v":
    case "vh":
    case "sv":
    case "svh":
      return StreamLanguage.define(verilog);
    case "vhd":
    case "vhdl":
      return StreamLanguage.define(vhdl);
    case "tcl":
      return StreamLanguage.define(tcl);
    case "s":
    case "asm":
      return StreamLanguage.define(gas);
    case "ttcn":
      return StreamLanguage.define(ttcn);

    // Misc / niche
    case "dart":
      return StreamLanguage.define(dart);
    case "diff":
    case "patch":
      return StreamLanguage.define(diff);
    case "tex":
    case "ltx":
    case "sty":
    case "cls":
      return StreamLanguage.define(stex);
    case "nginx":
    case "conf":
      return StreamLanguage.define(nginx);

    // Config / dot-rc files
    case "ini":
    case "cfg":
    case "properties":
    case "env":
    case "editorconfig":
      return StreamLanguage.define(properties);

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
