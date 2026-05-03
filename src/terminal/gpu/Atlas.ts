/**
 * Glyph atlas — rasterizes a fixed glyph set onto an OffscreenCanvas
 * once at startup, then uploads it as a single GPUTexture. The
 * GridRenderer samples this texture per-cell to draw text.
 *
 * Phase 3 skeleton scope: ASCII printable range (0x20–0x7E). Wide
 * glyphs (CJK, emoji), ZWJ sequences, and combining marks land in
 * Phase 4 — they need grapheme-cluster keying and a 2-cell-wide
 * sprite layout that this version doesn't implement.
 */

const ASCII_START = 0x20;
const ASCII_END = 0x7e;

export interface AtlasEntry {
  /** Top-left UV in normalized atlas space (0..1). */
  u: number;
  v: number;
  /** Glyph cell extent in normalized atlas space. */
  w: number;
  h: number;
}

export interface Atlas {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  /** Cell size in physical (DPR-scaled) pixels. */
  cellWidthPx: number;
  cellHeightPx: number;
  /** Cell size in CSS pixels (used by the renderer's projection math). */
  cellWidthCss: number;
  cellHeightCss: number;
  textureWidth: number;
  textureHeight: number;
  /** Returns null for codepoints outside the rasterized range. */
  lookup(codepoint: number): AtlasEntry | null;
  destroy(): void;
}

export interface AtlasOptions {
  font: string;
  fontSizeCss: number;
  lineHeight: number;
  dpr: number;
}

/**
 * Bake the atlas synchronously (well, as synchronously as offscreen
 * canvas font rendering allows). Caller must keep the returned Atlas
 * alive until it calls destroy().
 */
export function createAtlas(
  device: GPUDevice,
  opts: AtlasOptions,
): Atlas {
  const { font, fontSizeCss, lineHeight, dpr } = opts;

  // Measure the cell. We assume monospace — every glyph in the
  // printable ASCII range advances the same width as 'M'. If the
  // configured font isn't monospace this will misalign columns
  // (which is fine because it's a misconfiguration, not our bug).
  const probe = new OffscreenCanvas(64, 64);
  const probeCtx = probe.getContext("2d");
  if (!probeCtx) throw new Error("OffscreenCanvas 2d context unavailable");
  probeCtx.font = `${fontSizeCss * dpr}px ${font}`;
  const advance = probeCtx.measureText("M").width;
  const cellWidthPx = Math.ceil(advance);
  const cellHeightPx = Math.ceil(fontSizeCss * lineHeight * dpr);
  const cellWidthCss = cellWidthPx / dpr;
  const cellHeightCss = cellHeightPx / dpr;

  // Lay glyphs out in a 16-column grid. ASCII printable range is 95
  // codepoints, so we need 6 rows. Texture size = cell × grid.
  const COLS = 16;
  const numGlyphs = ASCII_END - ASCII_START + 1;
  const ROWS = Math.ceil(numGlyphs / COLS);
  const textureWidth = cellWidthPx * COLS;
  const textureHeight = cellHeightPx * ROWS;

  const canvas = new OffscreenCanvas(textureWidth, textureHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.clearRect(0, 0, textureWidth, textureHeight);
  ctx.font = `${fontSizeCss * dpr}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";

  const lookup = new Map<number, AtlasEntry>();
  for (let i = 0; i < numGlyphs; i++) {
    const codepoint = ASCII_START + i;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * cellWidthPx;
    const y = row * cellHeightPx;
    ctx.fillText(String.fromCharCode(codepoint), x, y);
    lookup.set(codepoint, {
      u: x / textureWidth,
      v: y / textureHeight,
      w: cellWidthPx / textureWidth,
      h: cellHeightPx / textureHeight,
    });
  }

  // Pull the rasterized bitmap into a GPUTexture. We use rgba8unorm
  // (NOT srgb) because the canvas 2d context already produces linear
  // pixels for #ffffff fills — re-srgb-encoding would over-brighten.
  const imageData = ctx.getImageData(0, 0, textureWidth, textureHeight);
  const texture = device.createTexture({
    size: { width: textureWidth, height: textureHeight },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.writeTexture(
    { texture },
    imageData.data,
    {
      bytesPerRow: textureWidth * 4,
      rowsPerImage: textureHeight,
    },
    { width: textureWidth, height: textureHeight },
  );

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  return {
    texture,
    view: texture.createView(),
    sampler,
    cellWidthPx,
    cellHeightPx,
    cellWidthCss,
    cellHeightCss,
    textureWidth,
    textureHeight,
    lookup: (cp) => lookup.get(cp) ?? null,
    destroy: () => texture.destroy(),
  };
}
