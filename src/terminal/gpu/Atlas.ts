/**
 * Glyph atlas — rasterizes glyphs lazily onto an OffscreenCanvas and
 * mirrors them into a single fixed-size GPUTexture. The GridRenderer
 * samples this texture per-cell to draw text.
 *
 * Three glyph variants live in the atlas:
 *   - regular
 *   - bold
 *   - italic
 * Bold-italic is rendered with the italic slot using bold weight on
 * the fly (the rasterized output drops back to regular if a font
 * doesn't carry both styles — that's a font config issue, not ours).
 *
 * The atlas pre-allocates a Shelf-Next-Fit packed texture (see Warp's
 * `crates/warpui/src/rendering/atlas/allocator.rs` for the inspiration)
 * sized for ~4096 glyph entries at the configured cell size. That's
 * enough headroom for Latin Extended, box drawing, the BMP code points
 * a typical agent / shell session exercises, and a few hundred
 * emoji-as-pict glyphs, without ever growing the texture. Glyphs that
 * would overflow the atlas degrade to the tofu glyph at U+FFFD.
 *
 * `lookup(codepoint, style)` is the hot path — it returns the cached
 * entry for already-rasterized glyphs, or rasterizes a new entry,
 * uploads the cell-sized sprite to the GPU texture, and returns it.
 * Rasterizing is synchronous (OffscreenCanvas 2d fillText) so callers
 * get a usable entry the same frame the codepoint first appears.
 */

export type GlyphStyle = 0 | 1 | 2; // 0 regular, 1 bold, 2 italic

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
  /**
   * Returns the atlas entry for the given codepoint + style, rasterizing
   * lazily on first encounter. Returns null only when the atlas has
   * filled all slots — at which point the renderer falls back to drawing
   * a blank cell with the right fg/bg.
   *
   * `text` is passed (instead of inferring from `codepoint`) so callers
   * can supply grapheme clusters (combining marks, ZWJ-joined emoji) as
   * a single sprite without us reconstructing them from a code point.
   */
  lookup(key: string, style: GlyphStyle, text: string): AtlasEntry | null;
  destroy(): void;
}

export interface AtlasOptions {
  font: string;
  fontSizeCss: number;
  lineHeight: number;
  dpr: number;
}

/**
 * Bake the atlas. The texture is pre-allocated empty; glyphs land
 * on first reference via `lookup()`.
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

  // Capacity = COLS × ROWS slots. 64 × 64 = 4096 slots holds Latin
  // Extended + box drawing + a comfortable emoji budget. At 13px
  // font on 2x DPR that's ~26px × 35px per cell × 64 × 64 ≈ 1664 ×
  // 2240 px = ~3.7M texels. Single rgba8 texture: ~15 MB. Fits in
  // any GPU memory budget we care about; spends RAM to spare us the
  // texture-array / re-allocate dance.
  const COLS = 64;
  const ROWS = 64;
  const SLOTS = COLS * ROWS;
  const textureWidth = cellWidthPx * COLS;
  const textureHeight = cellHeightPx * ROWS;

  // Backing 2d canvas for rasterization. We paint per-glyph cells
  // into this and copy each cell into the GPU texture in a single
  // writeTexture call.
  //
  // The local `ctx` is narrowed via a separate const so the closure-
  // captured reference in `rasterizeInto` below is also non-nullable
  // — TS doesn't narrow across capture boundaries, so the post-throw
  // type assertion has to live in a re-binding the closure can see.
  const canvas = new OffscreenCanvas(textureWidth, textureHeight);
  const ctxNullable = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctxNullable) throw new Error("OffscreenCanvas 2d context unavailable");
  const ctx: OffscreenCanvasRenderingContext2D = ctxNullable;
  ctx.clearRect(0, 0, textureWidth, textureHeight);
  ctx.textBaseline = "top";

  const texture = device.createTexture({
    size: { width: textureWidth, height: textureHeight },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // Pre-rasterize the tofu glyph (U+FFFD) so missing entries fall back
  // to it cheaply instead of painting blanks. Slot 0 is reserved.
  const cache = new Map<string, AtlasEntry>();
  let nextSlot = 0;

  function styleFontString(style: GlyphStyle): string {
    const pxSize = `${fontSizeCss * dpr}px`;
    switch (style) {
      case 1:
        return `bold ${pxSize} ${font}`;
      case 2:
        return `italic ${pxSize} ${font}`;
      default:
        return `${pxSize} ${font}`;
    }
  }

  function rasterizeInto(slot: number, style: GlyphStyle, text: string): AtlasEntry | null {
    if (slot >= SLOTS) return null;
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const x = col * cellWidthPx;
    const y = row * cellHeightPx;
    ctx.clearRect(x, y, cellWidthPx, cellHeightPx);
    ctx.font = styleFontString(style);
    ctx.fillStyle = "#ffffff";
    // Drop the glyph slightly inside the cell to allow descenders +
    // diacritics that extend past `lineHeight` to not clip into the
    // neighbour cell. ROUND to integer pixels — a fractional y here
    // forces `fillText` to anti-alias across two pixel rows, which
    // reads as a soft / fuzzy glyph even though the cell positioning
    // is pixel-perfect. The user reported this directly as "fuzzy"
    // terminal text after the earlier fixes lined up the cells.
    const padTop = Math.round(
      Math.max(0, (cellHeightPx - fontSizeCss * dpr) * 0.25),
    );
    ctx.fillText(text, x, y + padTop);
    // Pull just this cell's pixels for the GPU upload. writeTexture
    // wants tightly-packed rgba8 rows.
    const cellImage = ctx.getImageData(x, y, cellWidthPx, cellHeightPx);
    device.queue.writeTexture(
      { texture, origin: { x, y } },
      cellImage.data,
      {
        bytesPerRow: cellWidthPx * 4,
        rowsPerImage: cellHeightPx,
      },
      { width: cellWidthPx, height: cellHeightPx },
    );
    return {
      u: x / textureWidth,
      v: y / textureHeight,
      w: cellWidthPx / textureWidth,
      h: cellHeightPx / textureHeight,
    };
  }

  // Slot 0 — tofu. Rasterized eagerly so atlas-full lookups can fall
  // back to it without consuming a fresh slot mid-render.
  const tofu = rasterizeInto(0, 0, "�");
  nextSlot = 1;
  if (tofu) cache.set("�|0", tofu);

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
    lookup(key: string, style: GlyphStyle, text: string): AtlasEntry | null {
      const cacheKey = `${key}|${style}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      // Atlas full — degrade to the cached tofu so the cell at least
      // shows SOMETHING. Without this fallback unfamiliar glyphs would
      // render as solid bg.
      if (nextSlot >= SLOTS) {
        return cache.get("�|0") ?? null;
      }
      const slot = nextSlot++;
      const entry = rasterizeInto(slot, style, text);
      if (!entry) {
        return cache.get("�|0") ?? null;
      }
      cache.set(cacheKey, entry);
      return entry;
    },
    destroy: () => texture.destroy(),
  };
}
