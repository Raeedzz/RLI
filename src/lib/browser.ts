/**
 * Browser daemon client.
 *
 * Talks to the in-house headless-Chrome daemon shipped inside RLI's
 * Rust process (see `src-tauri/src/browser/`). The daemon binds
 * `127.0.0.1:4000` (or 4001..4099 if 4000 is busy) and exposes the same
 * HTTP contract gstack ships, plus three new POST routes for
 * interactive input forwarding.
 *
 * Two consumer types share this surface:
 *  1. The frontend `BrowserPane` (this module's primary caller).
 *  2. A `claude` running in any RLI terminal pane — it can curl the
 *     same endpoints to drive the same browser session.
 */
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { appDataDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";

const DEFAULT_BASE = "http://127.0.0.1:4000";
// Cache TTL for the resolved daemon URL. The previous "cache once
// forever" policy locked in DEFAULT_BASE on first call if the port
// file hadn't been written yet — even if the daemon later landed on
// 4001+ and wrote the file, every subsequent fetch still tried 4000
// and timed out. A 5s cache absorbs the per-call FS read cost while
// still letting the discovery loop find a late-arriving port file.
const BASE_TTL_MS = 5_000;

let cachedBase: string | null = null;
let cachedAt = 0;

/**
 * Resolve the daemon URL. Resolution chain, in order:
 *
 *   1. `RLI_BROWSER_URL` global override (for tests / external embeds).
 *   2. `browser_bound_port` Tauri command — reads `BrowserState.bound_port`
 *      directly. Cannot be stale or missing; this is the single source
 *      of truth inside the Rust process. The previous file-only
 *      resolution had a silent failure where the port file could be
 *      missing during the boot race (daemon binds 4001+ but the write
 *      hadn't landed yet) and React would fall back to 4000 with no
 *      signal that anything was wrong.
 *   3. `appDataDir()/browser-port` file — kept as a fallback for
 *      out-of-process readers (curl, agent scripts) and for the
 *      brief window before Tauri's IPC bridge is wired up.
 *   4. `DEFAULT_BASE` (`http://127.0.0.1:4000`) — last resort, will
 *      time out if the daemon ended up elsewhere.
 *
 * Result is cached for `BASE_TTL_MS` so we don't pay the lookup cost
 * on every fetch; the TTL is short enough that a late-bound daemon
 * still gets discovered within ~5s.
 */
async function baseUrl(): Promise<string> {
  const override = (globalThis as { RLI_BROWSER_URL?: string }).RLI_BROWSER_URL;
  if (override) return override;
  const now = Date.now();
  if (cachedBase && now - cachedAt < BASE_TTL_MS) return cachedBase;

  let resolved = DEFAULT_BASE;
  // 1. Tauri command (fastest, most reliable).
  try {
    const port = await invoke<number | null>("browser_bound_port");
    if (typeof port === "number" && port > 0) {
      resolved = `http://127.0.0.1:${port}`;
      cachedBase = resolved;
      cachedAt = now;
      return resolved;
    }
  } catch {
    // Tauri IPC not ready yet (very early boot) — fall through.
  }

  // 2. Port file (cross-process compatibility).
  try {
    const dir = await appDataDir();
    const portFile = await join(dir, "browser-port");
    const port = (await readTextFile(portFile)).trim();
    if (/^\d+$/.test(port)) {
      resolved = `http://127.0.0.1:${port}`;
    }
  } catch {
    // file missing → daemon hasn't written it yet. Fall through.
  }
  cachedBase = resolved;
  cachedAt = now;
  return resolved;
}

/**
 * Drop the cached base URL so the next fetch re-resolves from the
 * port file. Exposed in case a caller wants to force a recheck after
 * a known daemon restart; the TTL handles the common cases.
 */
export function invalidateBrowserBaseCache() {
  cachedBase = null;
  cachedAt = 0;
}

export interface BrowserHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface BrowserStatus {
  url: string | null;
  title: string | null;
  ready: boolean;
}

export interface BrowserLogEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

async function tryFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${await baseUrl()}${path}`, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${await baseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POST that surfaces the daemon's error body instead of collapsing
 * everything to a boolean. The `/navigate` route returns the actual
 * chromiumoxide error string (e.g. "Chrome launch: Connection refused")
 * as the 500 response body — we read it back so the BrowserPane can
 * show the real cause instead of a generic "daemon unreachable."
 */
async function postJsonWithError(
  path: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${await baseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: text.trim() || `daemon returned ${res.status} ${res.statusText}`,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function postEmpty(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${await baseUrl()}${path}`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export const browser = {
  health: async (): Promise<BrowserHealth> => {
    try {
      // 10s. The previous 3s was the actual cause of every
      // "AbortError: Fetch is aborted" the user was seeing in the
      // DaemonOffline UI — the daemon's first-launch sequence
      // (TcpListener bind + axum spawn + BrowserState publish) can
      // easily blow past 3s on a cold boot, especially while other
      // setup tokio tasks compete for the runtime. 10s leaves real
      // headroom while still catching a genuinely-dead daemon.
      const res = await fetch(`${await baseUrl()}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const body = (await res.json().catch(() => ({}))) as { version?: string };
      return { ok: true, version: body.version };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  status: () => tryFetch<BrowserStatus>("/status"),

  /** Returns a screenshot URL — pane consumes it as <img src=..>. */
  screenshotUrl: async (): Promise<string> =>
    `${await baseUrl()}/screenshot?t=${Date.now()}`,

  /** Tails recent console events. */
  console: () => tryFetch<{ entries: BrowserLogEntry[] }>("/console/recent"),

  /**
   * Navigate the daemon's headless Chrome to `url`. Returns the
   * daemon's error string on failure so the BrowserPane can surface
   * the real cause instead of "couldn't reach daemon."
   */
  navigate: (url: string) => postJsonWithError("/navigate", { url }),
  click: (x: number, y: number) => postJson("/click", { x, y }),
  type: (text: string) => postJson("/type", { text }),
  key: (key: string) => postJson("/key", { key }),
  back: () => postEmpty("/back"),
  forward: () => postEmpty("/forward"),
  reload: () => postEmpty("/reload"),

  /**
   * Drop the daemon's current Chrome session. The next /navigate or
   * /screenshot will lazy-spawn a fresh one. Used by the BrowserPane's
   * restart button to recover from a stuck session without restarting
   * the whole app. Returns true if a session was actually dropped
   * (false means there was nothing to drop, which is also fine).
   */
  restart: async (): Promise<boolean> => {
    try {
      const had = await invoke<boolean>("browser_restart");
      // Invalidate the daemon's screenshot URL too — the next tick
      // will reissue against the new session.
      return had;
    } catch {
      return false;
    }
  },

  /** Fire-and-forget — opens the live page in the user's real browser. */
  openInBrowser: async () => {
    const status = await browser.status();
    const url = status?.url;
    if (!url) return;
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank");
    }
  },
};
