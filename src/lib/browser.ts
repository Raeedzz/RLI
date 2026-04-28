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

let cachedBase: string | null = null;

/**
 * Resolve the daemon URL. Default is :4000; if the daemon ended up on a
 * different port (collision with an actual gstack install or a stale
 * socket) it writes the chosen port to `~/Library/Application
 * Support/RLI/browser-port`. We try that file once and cache the
 * result so subsequent fetches are instant.
 */
async function baseUrl(): Promise<string> {
  if (cachedBase) return cachedBase;
  const override = (globalThis as { RLI_BROWSER_URL?: string }).RLI_BROWSER_URL;
  if (override) {
    cachedBase = override;
    return override;
  }
  try {
    const dir = await appDataDir();
    const portFile = await join(dir, "browser-port");
    const port = (await readTextFile(portFile)).trim();
    if (/^\d+$/.test(port)) {
      cachedBase = `http://127.0.0.1:${port}`;
      return cachedBase;
    }
  } catch {
    // file missing → daemon must be on the default port.
  }
  cachedBase = DEFAULT_BASE;
  return cachedBase;
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
      const res = await fetch(`${await baseUrl()}/health`, {
        signal: AbortSignal.timeout(1500),
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
