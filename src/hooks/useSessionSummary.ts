import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { gemini } from "@/lib/gemini";
import { useAppDispatch } from "@/state/AppState";
import type { SessionId } from "@/state/types";

/**
 * Activity-driven tab summary pipeline (Task #13).
 *
 * Subscribes to the agent PTY's data stream for a session, maintains a
 * rolling 4KB plain-text buffer (ANSI stripped), and when:
 *   - it's been ≥3s since the last byte arrived, AND
 *   - the buffer ends in something that looks like a shell/agent prompt, AND
 *   - it's been ≥10s since the last summary fired
 * …sends the last 3KB to Flash-Lite for a one-line summary, then
 * dispatches `update-session` to set the new subtitle (which lights
 * up under the tab name and in the status bar).
 *
 * Failures (no API key, network error) are silently swallowed — the
 * subtitle just doesn't update. This is a polish feature, not a
 * load-bearing one.
 */

const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const PROMPT_REGEX = /[\$%>#❯➜]\s*$/;
const IDLE_MS = 3000;
const BUFFER_SIZE = 4096;
const SUMMARY_BYTES = 3000;
const MIN_INTERVAL_MS = 10_000;

const SUMMARY_SYSTEM =
  "You write one-line activity summaries of terminal sessions. " +
  "Output a single sentence under 70 characters. " +
  "No quotes, no markdown, no preamble. " +
  "Focus on the agent's most recent action or current task. " +
  "If the session is idle, describe what was last accomplished.";

export function useSessionSummary(sessionId: SessionId | null) {
  const dispatch = useAppDispatch();
  const bufferRef = useRef<string>("");
  const lastActivityRef = useRef<number>(0);
  const lastSummaryRef = useRef<number>(0);

  useEffect(() => {
    if (!sessionId) return;

    bufferRef.current = "";
    lastActivityRef.current = 0;
    lastSummaryRef.current = 0;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const decoder = new TextDecoder();

    const subscribe = async () => {
      unlisten = await listen<number[]>(
        `pty://agent-${sessionId}/data`,
        (event) => {
          if (cancelled) return;
          const text = decoder.decode(new Uint8Array(event.payload));
          const stripped = text.replace(ANSI_REGEX, "");
          const next = bufferRef.current + stripped;
          bufferRef.current =
            next.length > BUFFER_SIZE ? next.slice(-BUFFER_SIZE) : next;
          lastActivityRef.current = Date.now();
        },
      );
    };
    void subscribe();

    const tick = window.setInterval(async () => {
      if (cancelled) return;
      const now = Date.now();
      const buf = bufferRef.current;
      if (buf.length < 100) return;
      if (now - lastActivityRef.current < IDLE_MS) return;
      if (now - lastSummaryRef.current < MIN_INTERVAL_MS) return;
      if (!PROMPT_REGEX.test(buf.trimEnd())) return;

      lastSummaryRef.current = now;

      try {
        const summary = await gemini.generate({
          prompt: buf.slice(-SUMMARY_BYTES),
          system: SUMMARY_SYSTEM,
          maxTokens: 32,
          temperature: 0.4,
        });
        if (cancelled) return;
        const cleaned = summary
          .trim()
          .replace(/^["'`]|["'`]$/g, "")
          .replace(/\n.*$/s, "");
        if (cleaned) {
          dispatch({
            type: "update-session",
            id: sessionId,
            patch: { subtitle: cleaned },
          });
        }
      } catch {
        // Swallow — the user may not have set their Gemini key yet,
        // or the network is offline. Subtitle stays static.
      }
    }, 2_000);

    return () => {
      cancelled = true;
      unlisten?.();
      window.clearInterval(tick);
    };
  }, [sessionId, dispatch]);
}
