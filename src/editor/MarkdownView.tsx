import { useEffect } from "react";
import { useEditor, EditorContent, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Editor } from "./Editor";
import { useAppState } from "@/state/AppState";

/** Pull the canonical markdown source out of TipTap's storage. The
 *  markdown extension augments `editor.storage` with a `markdown`
 *  helper; tiptap-markdown 0.9.x doesn't ship a typed module
 *  augmentation, so we narrow through unknown here rather than
 *  letting `any` leak into the rest of the file. */
function getMarkdown(editor: TiptapEditor): string {
  const md = (
    editor.storage as unknown as { markdown?: { getMarkdown: () => string } }
  ).markdown;
  return md ? md.getMarkdown() : "";
}

interface Props {
  /** Absolute path of the file — passed through to the source editor for AskCard. */
  path: string;
  /** File content (markdown source). */
  content: string;
  /** Persist edits back into state. Fires from BOTH rich and source. */
  onChange: (content: string) => void;
}

/**
 * Markdown viewer/editor with two modes — driven from app state via
 * the `markdownView` flag. The Rich/Source toggle that flips that flag
 * lives in the pane header (rendered by `WorkspaceLayout`), so this
 * component itself is just two stacked viewers.
 *
 * Rich:   TipTap WYSIWYG. Renders the markdown as headings / lists /
 *         code blocks / tables and lets the user edit visually. On
 *         every keystroke we round-trip through the markdown extension
 *         to get the canonical markdown source back, then propagate
 *         via `onChange` — same path the source editor uses, so
 *         autosave / Cmd+S / git status all keep working.
 * Source: the regular CodeMirror editor every other text file uses.
 */
export function MarkdownView({ path, content, onChange }: Props) {
  const { markdownView } = useAppState();
  return markdownView === "rich" ? (
    <RichView content={content} onChange={onChange} />
  ) : (
    <Editor path={path} content={content} onChange={onChange} />
  );
}

function RichView({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
    ],
    content,
    onUpdate: ({ editor }) => {
      // The markdown extension exposes a serializer on the editor's
      // storage bag. Pull canonical markdown out and propagate so the
      // file state stays in sync with the user's WYSIWYG edits.
      onChange(getMarkdown(editor));
    },
    editorProps: {
      attributes: {
        // The .rli-markdown class slots in the same prose styling the
        // old preview used — headings, code blocks, tables, lists.
        // ProseMirror appends its own contenteditable + outline.
        class: "rli-markdown rli-rich-editor",
      },
    },
  });

  // External content swaps (e.g. switching between two .md files in
  // the same pane) need to push the new markdown into TipTap. We bail
  // when the values match to avoid clobbering the user's cursor on
  // their own typing.
  useEffect(() => {
    if (!editor) return;
    const current = getMarkdown(editor);
    if (current !== content) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [editor, content]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        overflow: "auto",
        padding: "var(--space-6) var(--space-8)",
        backgroundColor: "var(--surface-0)",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
