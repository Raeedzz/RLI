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
 * Resolve the daemon URL. Default is :4000; if the daemon ended up on
 * a different port (collision with an actual gstack install or a
 * stale socket) it writes the chosen port to Tauri's
 * `appDataDir()/browser-port`. We try that file every `BASE_TTL_MS`
 * so the frontend can recover when the daemon comes up late or on a
 * non-default port.
 */
async function baseUrl(): Promise<string> {
  const override = (globalThis as { RLI_BROWSER_URL?: string }).RLI_BROWSER_URL;
  if (override) return override;
  const now = Date.now();
  if (cachedBase && now - cachedAt < BASE_TTL_MS) return cachedBase;
  let resolved = DEFAULT_BASE;
  try {
    const dir = await appDataDir();
    const portFile = await join(dir, "browser-port");
    const port = (await readTextFile(portFile)).trim();
    if (/^\d+$/.test(port)) {
      resolved = `http://127.0.0.1:${port}`;
    }
  } catch {
    // file missing → daemon hasn't written it yet (or bound on
    // default). Fall through to DEFAULT_BASE and try again on the
    // next call after the TTL expires.
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
      // 3s — generous enough that a momentary webview pause (e.g.
      // panel collapse/expand transitions on the same render tick)
      // doesn't trip the timeout, but short enough that a genuinely
      // dead daemon still gives up fast. The BrowserPane retry loop
      // covers anything slower than that.
      const res = await fetch(`${await baseUrl()}/health`, {
        signal: AbortSignal.timeout(3000),
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

  navigate: (url: string) => postJson("/navigate", { url }),
  click: (x: number, y: number) => postJson("/click", { x, y }),
  type: (text: string) => postJson("/type", { text }),
  key: (key: string) => postJson("/key", { key }),
  back: () => postEmpty("/back"),
  forward: () => postEmpty("/forward"),
  reload: () => postEmpty("/reload"),

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
