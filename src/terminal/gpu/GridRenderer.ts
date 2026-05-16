/**
 * WebGPU grid renderer. Draws a terminal frame as instanced quads
 * sampling a glyph atlas. One draw call per frame for the visible
 * cells; uniforms carry cell size + canvas resolution.
 *
 * Current scope (post-Phase-3a):
 *   - Dynamic Unicode atlas (rasterize-on-miss; see Atlas.ts)
 *   - Bold / italic via atlas variants; dim via fragment alpha
 *   - Underline + strikethrough rendered in the fragment shader
 *     from per-cell flags packed into the instance data
 *   - Inverse swap of fg/bg
 *   - Cursor (block style) overlaid at the requested cell, with row
 *     coordinates honored in both whole-frame and inline windows
 *   - One draw call per frame; redundant rebuilds short-circuited by
 *     seq dedupe
 *
 * Not yet (Phase 3b):
 *   - Mouse selection + cmd+C copy
 *   - Cursor styles other than block (beam / underline)
 *   - Device-loss recovery — TODO before flipping default
 */

import type { DirtyRow, RenderFrame, Span } from "../types";
import { createAtlas, type Atlas, type GlyphStyle } from "./Atlas";

/**
 * Decoupled input the renderer actually consumes. Lets callers pass
 * either a whole frame (full-pane alt-screen) or a windowed subset
 * (inline LiveBlock body) without reshaping the frame itself.
 */
export interface RenderInput {
  /** Rows to draw, in display order (top to bottom). */
  rows: DirtyRow[];
  /** Total column count in the grid (used for cursor clamping). */
  cols: number;
  /** Monotonic id for dedupe. Skip render if unchanged since last. */
  seq: number;
  /**
   * Optional cursor position in cell coords (row index relative to
   * `rows[0]`, not the original grid). Pass null/undefined to hide.
   */
  cursor?: { row: number; col: number; visible: boolean } | null;
}

const SHADER = /* wgsl */ `
struct Uniforms {
  cellSize: vec2<f32>,
  resolution: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

// Bitmask packed into instance.flags:
//   bit 0 = underline
//   bit 1 = strikethrough
//   bit 2 = is-cursor (suppresses underline / strikethrough overlays)
const FLAG_UNDERLINE: u32 = 1u;
const FLAG_STRIKE: u32 = 2u;
const FLAG_CURSOR: u32 = 4u;

struct VertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) cellPos: vec2<f32>,
  @location(2) atlasUV: vec2<f32>,
  @location(3) atlasSize: vec2<f32>,
  @location(4) fgColor: vec4<f32>,
  @location(5) bgColor: vec4<f32>,
  @location(6) flags: u32,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) fg: vec4<f32>,
  @location(2) bg: vec4<f32>,
  @location(3) cellLocal: vec2<f32>,
  @location(4) @interpolate(flat) flags: u32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let pixelPos = (in.cellPos + in.quadPos) * u.cellSize;
  let clip = vec4<f32>(
    (pixelPos.x / u.resolution.x) * 2.0 - 1.0,
    -((pixelPos.y / u.resolution.y) * 2.0 - 1.0),
    0.0,
    1.0
  );
  let uv = in.atlasUV + in.quadPos * in.atlasSize;
  var out: VertexOutput;
  out.position = clip;
  out.uv = uv;
  out.fg = in.fgColor;
  out.bg = in.bgColor;
  // Local cell coords (0..1) — used to draw underline / strike bands
  // without needing a separate pipeline pass.
  out.cellLocal = in.quadPos;
  out.flags = in.flags;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Atlas glyphs were rasterized as white-on-transparent, so the alpha
  // channel is the coverage mask. Blend the foreground over the
  // background using that mask.
  let coverage = textureSample(atlasTex, atlasSampler, in.uv).a;
  var rgb = mix(in.bg.rgb, in.fg.rgb, coverage);
  var alpha = max(in.bg.a, in.fg.a * coverage);

  // Underline + strikethrough overlays. We paint a thin band in the
  // foreground color when the corresponding flag is set, drawn over
  // both the glyph and the background. Skipped for the cursor sprite
  // (the cursor's own bg is solid; layering a stripe on top would
  // create a notch).
  let isCursor = (in.flags & FLAG_CURSOR) != 0u;
  if (!isCursor) {
    if ((in.flags & FLAG_UNDERLINE) != 0u) {
      let v = in.cellLocal.y;
      if (v > 0.86 && v < 0.95) {
        rgb = in.fg.rgb;
        alpha = max(alpha, in.fg.a);
      }
    }
    if ((in.flags & FLAG_STRIKE) != 0u) {
      let v = in.cellLocal.y;
      if (v > 0.46 && v < 0.54) {
        rgb = in.fg.rgb;
        alpha = max(alpha, in.fg.a);
      }
    }
  }
  return vec4<f32>(rgb, alpha);
}
`;

/**
 * Instance attribute layout in bytes:
 *   cellPos      f32x2  (8)
 *   atlasUV      f32x2  (8)
 *   atlasSize    f32x2  (8)
 *   fgColor      f32x4  (16)
 *   bgColor      f32x4  (16)
 *   flags        u32    (4)
 *   padding      u32x3  (12, padding to 72-byte alignment for u32x4 row)
 *
 * Total = 72 bytes per instance. The 12-byte tail keeps the next
 * instance's `cellPos` aligned to the same offset for every slot —
 * WebGPU is happy as long as `arrayStride` is a multiple of 4 and the
 * attributes don't straddle a 16-byte boundary in a way the validation
 * layer rejects. 72 satisfies that without playing alignment games.
 */
const BYTES_PER_CELL = 72;
const U32_PER_CELL = BYTES_PER_CELL / 4;

const FLAG_UNDERLINE = 1;
const FLAG_STRIKE = 2;
const FLAG_CURSOR = 4;

export class GridRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private atlas: Atlas;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private uniformBuffer: GPUBuffer;
  private quadBuffer: GPUBuffer;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCapacity = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  /** Reused scratch buffer to avoid GC on every render. */
  private scratch = new ArrayBuffer(0);
  private scratchF32 = new Float32Array(0);
  private scratchU32 = new Uint32Array(0);
  /** Last frame's seq — short-circuits redundant rebuilds. */
  private lastSeq = -1;

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    atlas: Atlas,
  ) {
    this.device = device;
    this.context = context;
    this.atlas = atlas;

    const quadVerts = new Float32Array([
      0, 0, 1, 0, 0, 1,
      1, 0, 1, 1, 0, 1,
    ]);
    this.quadBuffer = device.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadBuffer, 0, quadVerts);

    this.uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = device.createShaderModule({ code: SHADER });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: atlas.view },
        { binding: 2, resource: atlas.sampler },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 8,
            stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
            ],
          },
          {
            arrayStride: BYTES_PER_CELL,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x2" },
              { shaderLocation: 2, offset: 8, format: "float32x2" },
              { shaderLocation: 3, offset: 16, format: "float32x2" },
              { shaderLocation: 4, offset: 24, format: "float32x4" },
              { shaderLocation: 5, offset: 40, format: "float32x4" },
              { shaderLocation: 6, offset: 56, format: "uint32" },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    // Force the next render to repaint regardless of seq dedupe.
    this.lastSeq = -1;
  }

  /**
   * Convenience: render a full RenderFrame (alt-screen / full-pane
   * case). Iterates `frame.dirty` and pulls cursor from frame.
   */
  renderFrame(frame: RenderFrame | null): void {
    if (!frame) {
      this.draw(0);
      return;
    }
    // RenderFrame.dirty IS the full grid for the alt-screen / full-pane
    // case (the backend sends every row in this mode), so `cursor_row`
    // — a row index into the original grid — is also a valid index
    // into rows.
    this.render({
      rows: frame.dirty,
      cols: frame.cols,
      seq: frame.seq,
      cursor: {
        row: frame.cursor_row,
        col: frame.cursor_col,
        visible: true,
      },
    });
  }

  render(input: RenderInput): void {
    if (input.seq === this.lastSeq) return;
    this.lastSeq = input.seq;

    const { cellWidthCss, cellHeightCss } = this.atlas;
    let count = 0;
    for (const dr of input.rows) {
      for (const span of dr.spans) {
        // Count by Unicode code-point sequences (we render one cell per
        // code point; combining marks would ideally cluster, but that's
        // a future refinement and the cells past the base are blanks
        // either way since alacritty inlines combining marks into the
        // base cell's zerowidth list).
        count += stringLengthInCodepoints(span.text);
      }
    }

    const cursor = input.cursor;
    const drawCursor =
      cursor !== null &&
      cursor !== undefined &&
      cursor.visible &&
      cursor.row >= 0 &&
      cursor.row < input.rows.length &&
      cursor.col >= 0 &&
      cursor.col < input.cols;
    const totalCount = count + (drawCursor ? 1 : 0);

    if (totalCount === 0) {
      this.draw(0);
      return;
    }

    if (totalCount > this.instanceCapacity) {
      this.growInstanceBuffer(totalCount);
    }
    const neededBytes = totalCount * BYTES_PER_CELL;
    if (this.scratch.byteLength < neededBytes) {
      const cap = nextPow2(neededBytes);
      this.scratch = new ArrayBuffer(cap);
      this.scratchF32 = new Float32Array(this.scratch);
      this.scratchU32 = new Uint32Array(this.scratch);
    }

    const f32 = this.scratchF32;
    const u32 = this.scratchU32;
    let slot = 0;
    for (let r = 0; r < input.rows.length; r++) {
      const dr = input.rows[r];
      // Windowed rows render packed top-down regardless of dr.row.
      // Callers using dr.row as a grid coordinate (alt-screen full
      // frame) get the same answer because dr.row matches r in that
      // mode anyway.
      const row = r;
      let col = 0;
      for (const span of dr.spans) {
        const fg = parseColor(span.fg, [1, 1, 1, 1]);
        const bg = parseColor(span.bg, [0, 0, 0, 0]);
        const fr = span.inverse ? bg[0] : fg[0];
        const fgG = span.inverse ? bg[1] : fg[1];
        const fb = span.inverse ? bg[2] : fg[2];
        const fa = span.inverse ? bg[3] : fg[3];
        const br = span.inverse ? fg[0] : bg[0];
        const bgG = span.inverse ? fg[1] : bg[1];
        const bb = span.inverse ? fg[2] : bg[2];
        const ba = span.inverse ? fg[3] : bg[3];
        const dim = span.dim ? 0.6 : 1;
        const style: GlyphStyle = span.bold ? 1 : span.italic ? 2 : 0;
        let flags = 0;
        if (span.underline) flags |= FLAG_UNDERLINE;
        if (span.strikeout) flags |= FLAG_STRIKE;
        // Walk by grapheme code point so emoji + supplementary-plane
        // chars get their own cell instead of being split into two
        // half-cells (which would render as garbled pairs).
        for (const ch of span.text) {
          const entry = this.atlas.lookup(ch, style, ch);
          const offBytes = slot * BYTES_PER_CELL;
          const offF32 = offBytes / 4;
          const offU32 = offBytes / 4;
          f32[offF32 + 0] = col;
          f32[offF32 + 1] = row;
          if (entry) {
            f32[offF32 + 2] = entry.u;
            f32[offF32 + 3] = entry.v;
            f32[offF32 + 4] = entry.w;
            f32[offF32 + 5] = entry.h;
          } else {
            f32[offF32 + 2] = 0;
            f32[offF32 + 3] = 0;
            f32[offF32 + 4] = 0;
            f32[offF32 + 5] = 0;
          }
          f32[offF32 + 6] = fr * dim;
          f32[offF32 + 7] = fgG * dim;
          f32[offF32 + 8] = fb * dim;
          f32[offF32 + 9] = fa;
          f32[offF32 + 10] = br;
          f32[offF32 + 11] = bgG;
          f32[offF32 + 12] = bb;
          f32[offF32 + 13] = ba;
          u32[offU32 + 14] = flags;
          slot++;
          col++;
        }
      }
    }

    if (drawCursor && cursor) {
      // Block cursor: solid accent fill, no glyph (atlas size = 0).
      // The fragment shader's underline/strike paths are suppressed by
      // FLAG_CURSOR so a strike-through cell doesn't paint a notch
      // over the cursor block.
      const offBytes = slot * BYTES_PER_CELL;
      const offF32 = offBytes / 4;
      const offU32 = offBytes / 4;
      f32[offF32 + 0] = cursor.col;
      f32[offF32 + 1] = cursor.row;
      f32[offF32 + 2] = 0;
      f32[offF32 + 3] = 0;
      f32[offF32 + 4] = 0;
      f32[offF32 + 5] = 0;
      // fg unused (no glyph), bg is the cursor color. Soft white-ish
      // accent — pulling this from a CSS variable is a follow-up.
      f32[offF32 + 6] = 0;
      f32[offF32 + 7] = 0;
      f32[offF32 + 8] = 0;
      f32[offF32 + 9] = 0;
      f32[offF32 + 10] = 0.92;
      f32[offF32 + 11] = 0.92;
      f32[offF32 + 12] = 0.92;
      f32[offF32 + 13] = 0.85;
      u32[offU32 + 14] = FLAG_CURSOR;
      slot++;
    }

    this.device.queue.writeBuffer(
      this.instanceBuffer!,
      0,
      this.scratch,
      0,
      slot * BYTES_PER_CELL,
    );

    const uniforms = new Float32Array([
      cellWidthCss,
      cellHeightCss,
      this.cssWidth,
      this.cssHeight,
      0,
      0,
      0,
      0,
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    this.draw(slot);
  }

  destroy(): void {
    this.atlas.destroy();
    this.uniformBuffer.destroy();
    this.quadBuffer.destroy();
    this.instanceBuffer?.destroy();
  }

  private growInstanceBuffer(needed: number): void {
    this.instanceCapacity = nextPow2(needed);
    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceCapacity * BYTES_PER_CELL,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private draw(instanceCount: number): void {
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    if (instanceCount > 0 && this.instanceBuffer) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.quadBuffer);
      pass.setVertexBuffer(1, this.instanceBuffer);
      pass.draw(6, instanceCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

/**
 * Count user-perceived characters in a string by iterating code points
 * (the for..of iterator yields one element per code point, handling
 * surrogate pairs correctly). Emoji + supplementary-plane chars come
 * back as one element instead of two.
 */
function stringLengthInCodepoints(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

function parseColor(
  css: string,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (!css || css === "transparent") return [0, 0, 0, 0];
  if (css.charCodeAt(0) === 35 /* # */) {
    if (css.length === 7) {
      return [
        parseInt(css.slice(1, 3), 16) / 255,
        parseInt(css.slice(3, 5), 16) / 255,
        parseInt(css.slice(5, 7), 16) / 255,
        1,
      ];
    }
    if (css.length === 4) {
      const r = parseInt(css[1], 16);
      const g = parseInt(css[2], 16);
      const b = parseInt(css[3], 16);
      return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, 1];
    }
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(css);
  if (m) {
    return [
      parseInt(m[1]) / 255,
      parseInt(m[2]) / 255,
      parseInt(m[3]) / 255,
      m[4] === undefined ? 1 : parseFloat(m[4]),
    ];
  }
  return fallback;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Bootstrap a renderer for a given canvas. Throws if WebGPU is not
 * available — GLI ships only as a Tauri DMG on macOS 14+, so this
 * is a configuration error worth surfacing loudly rather than a
 * fallback path.
 */
export async function createGridRenderer(
  canvas: HTMLCanvasElement,
  font: string,
  fontSizeCss: number,
  lineHeight: number,
): Promise<GridRenderer> {
  if (!navigator.gpu) {
    throw new Error("WebGPU not available — GLI requires macOS 14+");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter available");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Canvas WebGPU context unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "premultiplied",
  });
  const dpr = window.devicePixelRatio || 1;
  const atlas = createAtlas(device, {
    font,
    fontSizeCss,
    lineHeight,
    dpr,
  });
  return new GridRenderer(device, context, format, atlas);
}

// Re-export so call sites can pull `Span` from one place.
export type { Span };
