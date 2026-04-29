/**
 * File-kind classifier used by the editor and the open-file flow so we
 * don't try to round-trip binary bytes through CodeMirror as UTF-8.
 *
 * - "text" — open in CodeMirror like before
 * - "image" — preview as <img> via Tauri's asset:// protocol
 * - "binary" — show a small info card; we don't read the bytes
 */
export type FileKind = "text" | "image" | "binary";

const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svg", "avif", "tiff",
]);

/**
 * Anything we should NOT try to load as text. Mirrors `NO_AUTOSAVE_EXT`
 * in `SplitLayout` (the two need to stay in sync — if you can't safely
 * write it back, you shouldn't have parsed it as a string in the first
 * place).
 */
const BINARY_EXT = new Set([
  ...IMAGE_EXT,
  "pdf",
  "mp4", "mov", "mkv", "webm", "avi",
  "mp3", "wav", "ogg", "flac", "m4a",
  "zip", "gz", "tar", "tgz", "bz2", "xz", "7z",
  "exe", "dll", "dylib", "so", "bin", "wasm",
  "sqlite", "db", "lock",
  "ttf", "otf", "woff", "woff2",
  "psd", "ai", "sketch", "fig",
  "node",
]);

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  if (i < 0 || i === path.length - 1) return "";
  return path.slice(i + 1).toLowerCase();
}

export function fileKind(path: string): FileKind {
  const e = ext(path);
  if (IMAGE_EXT.has(e)) return "image";
  if (BINARY_EXT.has(e)) return "binary";
  return "text";
}

export function isBinaryPath(path: string): boolean {
  return fileKind(path) !== "text";
}
