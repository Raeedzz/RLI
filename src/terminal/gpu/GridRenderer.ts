/**
 * WebGPU grid renderer. Draws a terminal frame as instanced quads
 * sampling a glyph atlas. One draw call per frame for the visible
 * cells; uniforms carry cell size + canvas resolution.
 *
 * Phase 3 skeleton scope:
 *   - ASCII glyphs from the atlas (Phase 4: full Unicode + emoji)
 *   - Foreground + background blend in one fragment pass
 *   - No selection, no cursor blink, no underline/strikethrough
 *   - No device-loss recovery (Phase 4)
 *   - No DPR change handling beyond initial mount (Phase 4)
 *
 * Inputs flow as `RenderFrame.dirty` → instance buffer → one draw.
 * The instance buffer reuses its allocation across frames; we only
 * grow when the cell count exceeds capacity.
 */

import type { DirtyRow, RenderFrame } from "../types";
import { createAtlas, type Atlas } from "./Atlas";

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

struct VertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) cellPos: vec2<f32>,
  @location(2) atlasUV: vec2<f32>,
  @location(3) atlasSize: vec2<f32>,
  @location(4) fgColor: vec4<f32>,
  @location(5) bgColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) fg: vec4<f32>,
  @location(2) bg: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let pixelPos = (in.cellPos + in.quadPos) * u.cellSize;
  // Map from CSS pixels (0..resolution) to clip space (-1..1).
  // Y is flipped because our cell coordinates grow downward.
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
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Atlas glyphs were rasterized as white-on-transparent, so the alpha
  // channel is the coverage mask. Blend the foreground over the
  // background using that mask.
  let coverage = textureSample(atlasTex, atlasSampler, in.uv).a;
  let rgb = mix(in.bg.rgb, in.fg.rgb, coverage);
  let alpha = max(in.bg.a, in.fg.a * coverage);
  return vec4<f32>(rgb, alpha);
}
`;

/** Instance attribute layout in floats: cellPos(2) + uv(2) + uvSize(2) + fg(4) + bg(4). */
const FLOATS_PER_CELL = 14;
const BYTES_PER_CELL = FLOATS_PER_CELL * 4;

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
  private scratch = new Float32Array(0);
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

    // Unit quad (two triangles), vertex coords in [0,1]. Instanced
    // per-cell: shader translates and scales by cellSize + cellPos.
    const quadVerts = new Float32Array([
      0, 0, 1, 0, 0, 1,
      1, 0, 1, 1, 0, 1,
    ]);
    this.quadBuffer = device.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadBuffer, 0, quadVerts);

    // Uniform: cellSize(vec2) + resolution(vec2) = 16 bytes; padded
    // to 32 because vec2<f32> in a uniform block packs to 8 bytes
    // and WebGPU requires the buffer be a multiple of 16.
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
    this.render({
      rows: frame.dirty,
      cols: frame.cols,
      seq: frame.seq,
      cursor: {
        row: frame.cursor_row,
        col: frame.cursor_col,
        visible: !frame.alt_screen || true, // always visible for now
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
        count += span.text.length;
      }
    }

    // Cursor takes one extra instance slot. Drawn last so it overlays
    // any glyph at the cursor position. Block-style cursor: solid
    // bg, no glyph (atlas size 0).
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
    if (this.scratch.length < totalCount * FLOATS_PER_CELL) {
      this.scratch = new Float32Array(nextPow2(totalCount * FLOATS_PER_CELL));
    }

    const data = this.scratch;
    let ptr = 0;
    for (let r = 0; r < input.rows.length; r++) {
      const dr = input.rows[r];
      // For the windowed-rows case (inline LiveBlock), display rows
      // are packed sequentially starting at 0, NOT at dr.row. The
      // caller decides what they want — using dr.row here would
      // create gaps when rows aren't contiguous.
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
        for (let i = 0; i < span.text.length; i++) {
          const cp = span.text.charCodeAt(i);
          const entry = this.atlas.lookup(cp);
          data[ptr++] = col;
          data[ptr++] = row;
          if (entry) {
            data[ptr++] = entry.u;
            data[ptr++] = entry.v;
            data[ptr++] = entry.w;
            data[ptr++] = entry.h;
          } else {
            data[ptr++] = 0;
            data[ptr++] = 0;
            data[ptr++] = 0;
            data[ptr++] = 0;
          }
          data[ptr++] = fr * dim;
          data[ptr++] = fgG * dim;
          data[ptr++] = fb * dim;
          data[ptr++] = fa;
          data[ptr++] = br;
          data[ptr++] = bgG;
          data[ptr++] = bb;
          data[ptr++] = ba;
          col++;
        }
      }
    }

    if (drawCursor && cursor) {
      // Block cursor: solid accent fill, no glyph (atlas size = 0).
      // Drawn last so it overlays whatever's at the cell.
      data[ptr++] = cursor.col;
      data[ptr++] = cursor.row;
      data[ptr++] = 0;
      data[ptr++] = 0;
      data[ptr++] = 0;
      data[ptr++] = 0;
      // fg unused (no glyph), bg is the cursor color. Soft white-ish
      // accent — a Phase 4 pass will pull this from CSS variables.
      data[ptr++] = 0;
      data[ptr++] = 0;
      data[ptr++] = 0;
      data[ptr++] = 0;
      data[ptr++] = 0.92;
      data[ptr++] = 0.92;
      data[ptr++] = 0.92;
      data[ptr++] = 0.85;
    }

    this.device.queue.writeBuffer(
      this.instanceBuffer!,
      0,
      data.buffer,
      data.byteOffset,
      totalCount * BYTES_PER_CELL,
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

    this.draw(totalCount);
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
