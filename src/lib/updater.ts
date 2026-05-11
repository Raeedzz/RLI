import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Thin wrapper around `@tauri-apps/plugin-updater`.
 *
 * The plugin handles signature verification, download, and install
 * for us — this module exists so the React layer can drive the
 * lifecycle (idle → available → downloading → ready → applied) and
 * report progress to a UI toast without dragging the plugin types
 * into every component.
 *
 * The endpoint + ed25519 pubkey are declared in
 * `src-tauri/tauri.conf.json` under `plugins.updater`. The release
 * workflow signs new builds with the matching private key — see
 * `.github/workflows/release.yml`.
 */

export type UpdaterPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "applying" }
  | { kind: "error"; message: string };

/**
 * Probe the configured endpoint. Returns the Update handle when a
 * newer version is available, or null when the running build is
 * already current. Throws when the endpoint is unreachable / the
 * response can't be parsed — caller is expected to catch and surface.
 */
export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  return update ?? null;
}

/**
 * Download + install the update, forwarding progress to the caller.
 * Tauri returns three event kinds during `downloadAndInstall`:
 *
 *   - `Started`  { contentLength?: number }
 *   - `Progress` { chunkLength: number }
 *   - `Finished`
 *
 * We collapse those into the simpler `downloading → ready` view the
 * UI cares about. The app needs an explicit `relaunch()` afterwards —
 * Tauri does not auto-restart on macOS.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress(0, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress(downloaded, total);
        break;
      case "Finished":
        onProgress(total ?? downloaded, total);
        break;
    }
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}
