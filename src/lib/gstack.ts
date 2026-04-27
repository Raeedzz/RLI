/**
 * GStack daemon client.
 *
 * GStack is Garry Tan's Claude Code skill pack with a persistent
 * headless Chromium daemon on localhost. Per its docs the daemon
 * exposes a small HTTP API (~100ms response time, persistent cookies +
 * sessions, multi-agent shared browser).
 *
 * RLI is a *client* — we don't run the daemon, we just observe it
 * and show the page state. If GStack isn't installed the panel will
 * surface an install hint instead of a stack trace.
 *
 * The exact endpoint paths shift between gstack versions. Centralising
 * them here makes the "wire to a different version" change a one-file
 * edit.
 */

const DEFAULT_BASE = "http://127.0.0.1:4000";

function baseUrl(): string {
  return (globalThis as { RLI_GSTACK_URL?: string }).RLI_GSTACK_URL ?? DEFAULT_BASE;
}

export interface GstackHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface GstackStatus {
  url: string | null;
  title: string | null;
  ready: boolean;
}

export interface GstackLogEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

async function tryFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl()}${path}`, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const gstack = {
  health: async (): Promise<GstackHealth> => {
    try {
      const res = await fetch(`${baseUrl()}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const body = (await res.json().catch(() => ({}))) as { version?: string };
      return { ok: true, version: body.version };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  status: () => tryFetch<GstackStatus>("/status"),

  /** Returns a screenshot URL — pane consumes it as <img src=..>. */
  screenshotUrl: (): string => `${baseUrl()}/screenshot?t=${Date.now()}`,

  /** Tails recent console events. */
  console: () => tryFetch<{ entries: GstackLogEntry[] }>("/console/recent"),

  /** Fire-and-forget — opens the live page in the user's real browser. */
  openInBrowser: async () => {
    const status = await gstack.status();
    const url = status?.url;
    if (!url) return;
    // Tauri provides shell.open; in dev or web fallback we also accept window.open
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank");
    }
  },
};
