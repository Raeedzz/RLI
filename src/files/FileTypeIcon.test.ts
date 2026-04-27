import { describe, expect, test } from "bun:test";
import { fileTypeFor } from "./FileTypeIcon";

describe("fileTypeFor", () => {
  test("recognizes common source extensions", () => {
    expect(fileTypeFor("main.rs").glyph).toBe("Rs");
    expect(fileTypeFor("App.tsx").glyph).toBe("Tx");
    expect(fileTypeFor("index.ts").glyph).toBe("Ts");
    expect(fileTypeFor("script.js").glyph).toBe("Js");
    expect(fileTypeFor("server.py").glyph).toBe("Py");
    expect(fileTypeFor("style.css").glyph).toBe("Cs");
  });

  test("matches whole filenames before extension", () => {
    // Cargo.toml could match by .toml ext, but we want the dedicated badge
    expect(fileTypeFor("Cargo.toml").glyph).toBe("Cg");
    expect(fileTypeFor("package.json").glyph).toBe("Pk");
    expect(fileTypeFor("Dockerfile").glyph).toBe("Dk");
    expect(fileTypeFor("README.md").glyph).toBe("Rd");
  });

  test("falls back to a neutral dot for unknown extensions", () => {
    expect(fileTypeFor("strange.xyz123").glyph).toBe("·");
    expect(fileTypeFor("noext").glyph).toBe("·");
  });

  test("is case-insensitive on extension", () => {
    expect(fileTypeFor("HEADER.RS").glyph).toBe("Rs");
    expect(fileTypeFor("App.TSX").glyph).toBe("Tx");
  });

  test("returns colors as CSS variable expressions", () => {
    // Color must be a string referencing a CSS var so it picks up the
    // active theme — never a raw hex that would lock to one palette.
    const spec = fileTypeFor("main.rs");
    expect(spec.color.startsWith("var(--")).toBe(true);
  });
});
