import { describe, expect, test } from "bun:test";
import { fileTypeFor } from "./FileTypeIcon";

/**
 * `fileTypeFor` is the lightweight descriptor consumed by callers
 * that need to know the file's general kind without rendering an
 * icon. The richer per-type rendering lives in <FileTypeIcon>, but
 * a stable descriptor function makes it easy to share the file-type
 * inference logic across callers (filename tints, telemetry tags,
 * etc.). These tests just check the descriptor still recognizes the
 * major file kinds — implementation details (specific glyph chars,
 * hex color values) intentionally aren't asserted, since they shift
 * as the visual treatment evolves.
 */
describe("fileTypeFor", () => {
  test("recognizes TypeScript", () => {
    expect(fileTypeFor("index.ts").glyph).toBe("TS");
    expect(fileTypeFor("App.tsx").glyph).toBe("TS");
  });

  test("recognizes JavaScript", () => {
    expect(fileTypeFor("script.js").glyph).toBe("JS");
    expect(fileTypeFor("legacy.jsx").glyph).toBe("JS");
  });

  test("recognizes Rust, Python, Markdown, JSON", () => {
    expect(fileTypeFor("main.rs").glyph).toBe("Rs");
    expect(fileTypeFor("server.py").glyph).toBe("Py");
    expect(fileTypeFor("README.md").glyph).toBe("Md");
    expect(fileTypeFor("config.json").glyph).toBe("JSN");
  });

  test("matches Dockerfile and its prefix variants", () => {
    expect(fileTypeFor("Dockerfile").glyph).toBe("Dk");
    expect(fileTypeFor("Dockerfile.dev").glyph).toBe("Dk");
    expect(fileTypeFor("Dockerfile.prod").glyph).toBe("Dk");
  });

  test("falls back to a neutral dot for unknown extensions", () => {
    expect(fileTypeFor("strange.xyz123").glyph).toBe("·");
    expect(fileTypeFor("noext").glyph).toBe("·");
  });

  test("is case-insensitive on extension", () => {
    expect(fileTypeFor("HEADER.RS").glyph).toBe("Rs");
    expect(fileTypeFor("App.TSX").glyph).toBe("TS");
  });
});
