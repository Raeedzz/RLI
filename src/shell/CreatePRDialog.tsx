import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppDispatch, useAppState } from "@/state/AppState";
import { projectSettings } from "@/state/types";
import { useToast } from "@/primitives/Toast";

interface PrDraft {
  title: string;
  body: string;
}

/**
 * Minimal Create PR dialog. Calls `pr_draft` (helper-agent) to populate
 * title + body from the worktree's diff, lets the user edit, then
 * `pr_create` shells out to `gh pr create`. Toasts the returned URL.
 */
export function CreatePRDialog() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const open = !!state.prDialogOpen;
  const mode = state.prDialogOpen?.mode ?? "auto";
  const worktreeId = state.prDialogOpen?.worktreeId ?? null;
  const worktree = worktreeId ? state.worktrees[worktreeId] : null;
  const [draft, setDraft] = useState<PrDraft>({ title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether mouse-down originated on the backdrop. Without this,
  // a drag that starts inside the dialog (e.g. selecting text in the
  // textarea) and releases on the backdrop would close the dialog.
  const backdropMouseDownRef = useRef(false);

  useEffect(() => {
    if (!open || !worktree) return;
    setDraft({ title: "", body: "" });
    setError(null);
    if (mode === "manual") {
      // User asked for an empty form — don't burn an agent invocation.
      setBusy(false);
      return;
    }
    setBusy(true);
    const cli = worktree.agentCli ?? state.settings.helperCliPr;
    const model =
      cli === state.settings.helperCliPr ? state.settings.helperModelPr : "";
    const project = state.projects[worktree.projectId];
    const cfg = projectSettings(project);
    const extras = [cfg.prefs.general, cfg.prefs.createPR]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    void invoke<PrDraft>("pr_draft", {
      cwd: worktree.path,
      cli,
      model: model && model.length > 0 ? model : null,
      extras: extras.length > 0 ? extras : null,
    })
      .then((d) => setDraft(d))
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  }, [
    open,
    mode,
    worktree?.id,
    worktree?.path,
    worktree?.agentCli,
    state.settings.helperCliPr,
    state.settings.helperModelPr,
  ]);

  const close = () => dispatch({ type: "set-pr-dialog", worktreeId: null });

  const submit = async () => {
    if (!worktree) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ url: string }>("pr_create", {
        cwd: worktree.path,
        title: draft.title,
        body: draft.body,
      });
      toast.show({
        message: `PR created`,
        action: {
          label: "Open",
          onClick: () => {
            void invoke("system_open", { path: result.url }).catch(() => {});
          },
        },
      });
      close();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && worktree && (
        <motion.div
          key="pr-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          // Only close when the click lands on the backdrop itself —
          // bubbled events from children (textarea selection drags,
          // accidental highlights, dropdown menus from a future field)
          // should not be able to dismiss the dialog. Also handles
          // mousedown so a press-and-drag from inside the dialog that
          // ends on the backdrop doesn't count as an outside click.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              backdropMouseDownRef.current = true;
            }
          }}
          onMouseUp={(e) => {
            if (
              backdropMouseDownRef.current &&
              e.target === e.currentTarget
            ) {
              close();
            }
            backdropMouseDownRef.current = false;
          }}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: "var(--z-modal-backdrop)",
            display: "grid",
            placeItems: "start center",
            paddingTop: "min(15vh, 140px)",
          }}
        >
          <motion.div
            key="pr-dialog"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(680px, 90vw)",
              maxHeight: "70vh",
              backgroundColor: "var(--surface-2)",
              border: "var(--border-1)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-modal)",
              overflow: "hidden",
              display: "grid",
              gridTemplateRows: "auto 1fr auto",
              zIndex: "var(--z-modal)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "var(--space-3)",
                borderBottom: "var(--border-1)",
              }}
            >
              <span
                style={{
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--text-primary)",
                }}
              >
                Create pull request
              </span>
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {worktree.branch}
              </span>
            </div>
            <div
              style={{
                padding: "var(--space-3)",
                display: "grid",
                gridGap: 8,
                minHeight: 0,
              }}
            >
              <input
                type="text"
                value={draft.title}
                placeholder={busy ? "drafting…" : "Title"}
                disabled={busy}
                className="allow-select"
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                style={{
                  width: "100%",
                  height: 36,
                  padding: "0 var(--space-2)",
                  backgroundColor: "var(--surface-1)",
                  border: "var(--border-1)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-base)",
                }}
              />
              <textarea
                value={draft.body}
                placeholder={busy ? "drafting…" : "Body"}
                disabled={busy}
                className="allow-select"
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                style={{
                  width: "100%",
                  minHeight: 200,
                  padding: "var(--space-2)",
                  backgroundColor: "var(--surface-1)",
                  border: "var(--border-1)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-sm)",
                  resize: "vertical",
                }}
              />
              {error && (
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--state-error)",
                  }}
                >
                  {error}
                </span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                padding: "var(--space-3)",
                borderTop: "var(--border-1)",
              }}
            >
              <button
                type="button"
                onClick={close}
                style={{
                  height: 28,
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-secondary)",
                  backgroundColor: "var(--surface-3)",
                  fontSize: "var(--text-sm)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !draft.title.trim()}
                style={{
                  height: 28,
                  padding: "0 var(--space-3)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  backgroundColor: "var(--accent-press)",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-medium)",
                  opacity: busy || !draft.title.trim() ? 0.5 : 1,
                }}
              >
                Create PR
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
