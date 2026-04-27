import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { backdropVariants, modalVariants } from "@/design/motion";
import { gemini } from "@/lib/gemini";
import { useAppDispatch, useAppState } from "@/state/AppState";

/**
 * Gemini API key dialog (Task #16).
 *
 * No multi-step wizard. Single screen — paste key, save. Stored in the
 * macOS Keychain via the `keyring` crate. The dialog opens from the
 * command palette ("Set Gemini API key…") or via the AppState
 * `apiKeyDialogOpen` flag.
 *
 * Validates by calling gemini_set_key, which trims/empty-checks. If
 * Gemini rejects on first use the user sees the underlying error in the
 * AskCard / commit-message UI.
 */
export function ApiKeyDialog() {
  const { apiKeyDialogOpen } = useAppState();
  const dispatch = useAppDispatch();
  const close = () => dispatch({ type: "set-api-key-dialog", open: false });

  return (
    <AnimatePresence>
      {apiKeyDialogOpen && (
        <motion.div
          key="apikey-backdrop"
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--backdrop)",
            zIndex: "var(--z-modal-backdrop)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <motion.div
            key="apikey-dialog"
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(480px, 90vw)",
              backgroundColor: "var(--surface-2)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-modal)",
              padding: "var(--space-5)",
              zIndex: "var(--z-modal)",
            }}
          >
            <Inner onClose={close} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Inner({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState("");
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; reply: string } | { ok: false; reason: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    gemini
      .keyStatus()
      .then((ok) => setHasExisting(ok))
      .catch(() => setHasExisting(false));
  }, []);

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await gemini.setKey(key.trim());
      setHasExisting(true);
      setKey("");
      setVerifyResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    setError(null);
    try {
      const reply = await gemini.generate({
        prompt: "Reply with the single word OK and nothing else.",
        maxTokens: 8,
        temperature: 0,
      });
      setVerifyResult({ ok: true, reply: reply.trim() });
    } catch (e) {
      setVerifyResult({ ok: false, reason: String(e) });
    } finally {
      setVerifying(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      await gemini.clearKey();
      setHasExisting(false);
      setKey("");
      setVerifyResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text-primary)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Gemini API key
        </div>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            color: "var(--text-tertiary)",
            marginTop: "var(--space-1)",
            lineHeight: "var(--leading-sm)",
          }}
        >
          Used for AI commit messages, highlight-and-ask, and tab summaries.
          Stored in the macOS Keychain — never written to a file.
        </div>
      </div>

      <input
        ref={inputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onClose();
        }}
        placeholder={
          hasExisting
            ? "(key already set — paste to replace)"
            : "AIza…"
        }
        className="allow-select"
        style={{
          width: "100%",
          height: 32,
          padding: "0 var(--space-3)",
          backgroundColor: "var(--surface-1)",
          border: "var(--border-2)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          outline: "none",
          fontVariantLigatures: "none",
        }}
      />

      {error && (
        <div
          style={{
            color: "var(--state-error)",
            fontSize: "var(--text-xs)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </div>
      )}

      {verifyResult && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            borderRadius: "var(--radius-sm)",
            backgroundColor: verifyResult.ok
              ? "var(--surface-success-soft)"
              : "var(--surface-error-soft)",
            color: verifyResult.ok
              ? "var(--state-success-bright)"
              : "var(--state-error-bright)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            fontVariantLigatures: "none",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "var(--radius-pill)",
              backgroundColor: "currentColor",
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, wordBreak: "break-word" }}>
            {verifyResult.ok
              ? `✓ Gemini replied: ${verifyResult.reply}`
              : `✗ ${verifyResult.reason}`}
          </span>
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2)",
        }}
      >
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          {hasExisting && (
            <>
              <button
                type="button"
                onClick={() => void verify()}
                disabled={verifying || saving}
                style={ghostButton({ tone: "neutral" })}
              >
                {verifying ? "verifying…" : "verify"}
              </button>
              <button
                type="button"
                onClick={() => void clear()}
                disabled={saving || verifying}
                style={ghostButton({ tone: "danger" })}
              >
                clear key
              </button>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving || verifying}
            style={ghostButton({ tone: "neutral" })}
          >
            close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !key.trim()}
            style={primaryButton({ disabled: saving || !key.trim() })}
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}

function ghostButton({
  tone,
}: {
  tone: "neutral" | "danger";
}): React.CSSProperties {
  return {
    height: 28,
    padding: "0 var(--space-3)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    color:
      tone === "danger" ? "var(--state-error)" : "var(--text-secondary)",
    backgroundColor: "transparent",
    border: "var(--border-1)",
    borderRadius: "var(--radius-sm)",
    cursor: "default",
  };
}

function primaryButton({
  disabled,
}: {
  disabled: boolean;
}): React.CSSProperties {
  return {
    height: 28,
    padding: "0 var(--space-4)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    color: "var(--text-inverse)",
    backgroundColor: disabled ? "var(--accent-muted)" : "var(--accent)",
    border: "none",
    borderRadius: "var(--radius-sm)",
    cursor: "default",
    opacity: disabled ? 0.6 : 1,
  };
}
