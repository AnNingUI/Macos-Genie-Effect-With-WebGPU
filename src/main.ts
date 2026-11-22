import genie_f from "./shaders/effect/Genie.fragment.wgsl?raw";
import genie_v from "./shaders/effect/Genie.vertex.wgsl?raw";
import {
  GENIE_DIRECTIONS,
  unionRect,
  type GenieDirection,
  type Rect,
  type Vec2,
} from "./genie";
import {
  drawElementToTexture,
  elementImageSize,
  isSupported,
  onPaint,
  requestPaint,
  supportsElementTexture,
  syncElementGeometry,
} from "./html-in-canvas";
import "./style.css";

// --- 设计基准（CSS 像素）---
const DESIGN_W = 800;
const DESIGN_H = 600;

// --- DPR 管理 ---
interface RenderScale {
  dpr: number; cssW: number; cssH: number; pxW: number; pxH: number;
}
const renderScale: RenderScale = {
  dpr: 1, cssW: DESIGN_W, cssH: DESIGN_H, pxW: DESIGN_W, pxH: DESIGN_H,
};

const canvasEl = document.getElementById("webgpu-canvas") as HTMLCanvasElement;
const windowEl = document.getElementById("genie-window") as HTMLDivElement;
const genieBtn = document.getElementById("genie-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const dirSelect = document.getElementById("dir-select") as HTMLSelectElement | null;
const infoEl = document.getElementById("info") as HTMLDivElement;
const unsupported = document.getElementById("unsupported") as HTMLDivElement;
const unsupportedDetail = document.getElementById("unsupported-detail") as HTMLParagraphElement;

function fail(reason: string): never {
  unsupported.hidden = false;
  unsupportedDetail.textContent = reason;
  throw new Error(reason);
}

if (!isSupported(canvasEl)) {
  fail("当前浏览器未提供 canvas.requestPaint()，无法使用 HTML-in-Canvas。");
}

const toPx = (v: number): number => v * renderScale.dpr;

function applyCanvasSize(force = false): boolean {
  const rect = canvasEl.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || DESIGN_W));
  const cssH = Math.max(1, Math.round(rect.height || DESIGN_H));
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));

  const changed = force ||
    renderScale.pxW !== pxW || renderScale.pxH !== pxH ||
    renderScale.cssW !== cssW || renderScale.cssH !== cssH ||
    renderScale.dpr !== dpr;
  if (!changed) return false;

  canvasEl.width = pxW;
  canvasEl.height = pxH;
  renderScale.dpr = dpr;
  renderScale.cssW = cssW;
  renderScale.cssH = cssH;
  renderScale.pxW = pxW;
  renderScale.pxH = pxH;
  return true;
}

// --- uniform 布局（112 bytes）---
//   0   viewport     vec2f
//   8   _pad0        vec2f
//   16  fromRect     vec4f
//   32  toRect       vec4f
//   48  dir          vec2f
//   56  progress     f32
//   60  curvePortion f32
//   64  quadMin      vec2f
//   72  quadMax      vec2f
//   80  _pad1        vec2f
// 合计 88 → 对齐到 96
/**
 * uniform 大小（float 数）。布局见 Genie.vertex.wgsl 的 Params：
 *   viewport(2) _pad0(2) rect(4) time curveDur transDur targetX targetY targetWidth _pad1(2)
 * = 16 floats = 64 bytes
 */
const UNIFORM_FLOATS = 16;

async function initWebGPU() {
  if (!navigator.gpu) { fail("此浏览器不支持 WebGPU。"); return null; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { fail("未找到可用的 GPUAdapter。"); return null; }
  const device = await adapter.requestDevice();

  if (!supportsElementTexture(device.queue)) {
    fail("WebGPU 已就绪，但 queue 上缺少 drawElementImageToTexture / copyElementImageToTexture。"
      + "请使用 Chrome 155+，或 Chrome 138+ 并开启 chrome://flags/#canvas-draw-element。");
  }

  const canvas = canvasEl;
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: "opaque" });
  return { device, context, canvasFormat, canvas };
}

/**
 * 形变后的形状一定落在「源矩形 ∪ 目标矩形」内，
 * 用一个四边形覆盖即可 —— 不必细分网格，这是 GPU 版比 CPU 版省的地方。
 */

class GenieApp {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvasFormat: GPUTextureFormat;
  canvas: HTMLCanvasElement;

  pipeline: GPURenderPipeline | null = null;
  sampler: GPUSampler | null = null;
  uniformBuffer: GPUBuffer | null = null;
  bindGroup0: GPUBindGroup | null = null;

  texture: GPUTexture | null = null;
  textureView: GPUTextureView | null = null;
  texSize = { width: 1, height: 1 };

  isAnimating = false;
  animationId: number | null = null;
  animationDuration = 1.0;
  /** 曲线阶段占比（与最初版一致：0.3s / 0.8s ≈ 0.375） */
  curvePortion = 0.375;
  /** 唯一画面状态 */
  private playhead = 0;

  windowRect: Rect = { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };
  targetRect: Rect = { x: DESIGN_W / 2 - 24, y: DESIGN_H - 40, w: 48, h: 20 };
  direction: GenieDirection = "down";

  private isResizing = false;
  private isRecreatingTexture = false;
  private uniformScratch = new Float32Array(UNIFORM_FLOATS);

  constructor(
    device: GPUDevice, context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat, canvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.canvas = canvas;
    this.layoutFromDOM();
  }

  layoutFromDOM(): void {
    const c = this.canvas.getBoundingClientRect();
    const w = windowEl.getBoundingClientRect();
    this.windowRect = {
      x: w.left - c.left, y: w.top - c.top, w: w.width, h: w.height,
    };
  }

  async init(): Promise<void> {
    applyCanvasSize(true);

    this.sampler = this.device.createSampler({
      magFilter: "linear", minFilter: "linear",
    });

    const module = this.device.createShaderModule({ code: genie_v + genie_f });

    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "main_vertex" },
      fragment: {
        module, entryPoint: "main_fragment",
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.createTexture();

    onPaint(this.canvas, () => {
      this.uploadTexture();
      this.present();
    });

    this.setupUI();
    this.setupWindowInteraction();

    this.createTexture();
    requestPaint(this.canvas);
    this.present();
  }

  createTexture(): void {
    if (this.isRecreatingTexture) return;
    this.isRecreatingTexture = true;
    try {
      const s = elementImageSize(this.canvas, windowEl);
      const w = Math.max(1, Math.ceil(s.width));
      const h = Math.max(1, Math.ceil(s.height));

      if (this.texture && w === this.texSize.width && h === this.texSize.height) return;

      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING |
               GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.textureView = this.texture.createView();
      this.texSize = { width: w, height: h };

      // 纹理换了，bind group 必须失效重建
      this.bindGroup0 = null;
      this.rebuildBindGroup();

      // 新纹理是空的，立刻填一次，否则首帧采样到全空 → 黑屏
      this.uploadTexture();
    } finally {
      this.isRecreatingTexture = false;
    }
    requestPaint(this.canvas);
  }

  uploadTexture(): void {
    if (!this.texture) return;
    drawElementToTexture(
      this.device.queue, windowEl, this.texture,
      this.texSize.width, this.texSize.height,
    );
  }

  rebuildBindGroup(): void {
    if (!this.pipeline || !this.uniformBuffer || !this.textureView || !this.sampler) return;
    this.bindGroup0 = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.textureView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  setupUI(): void {
    genieBtn?.addEventListener("click", () => this.startAnimation());
    resetBtn?.addEventListener("click", () => this.reset());

    if (dirSelect) {
      dirSelect.innerHTML = "";
      for (const key of Object.keys(GENIE_DIRECTIONS)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = key;
        if (key === this.direction) opt.selected = true;
        dirSelect.append(opt);
      }
      dirSelect.addEventListener("change", () => {
        this.direction = dirSelect.value as GenieDirection;
        this.updateTargetForDirection();
        this.present();
      });
    }
  }

  /** 演示用：把目标放到对应边缘。真实桌面里由 Dock 图标位置决定。 */
  updateTargetForDirection(): void {
    const t = 48, margin = 24;
    const cx = this.windowRect.x + this.windowRect.w / 2;
    const cy = this.windowRect.y + this.windowRect.h / 2;
    const W = renderScale.cssW || DESIGN_W;
    const H = renderScale.cssH || DESIGN_H;

    switch (this.direction) {
      case "down": this.targetRect = { x: cx - t / 2, y: H - margin - 20, w: t, h: 20 }; break;
      case "up": this.targetRect = { x: cx - t / 2, y: margin, w: t, h: 20 }; break;
      case "left": this.targetRect = { x: margin, y: cy - t / 2, w: 20, h: t }; break;
      case "right": this.targetRect = { x: W - margin - 20, y: cy - t / 2, w: 20, h: t }; break;
      case "downLeft": this.targetRect = { x: margin, y: H - margin - 20, w: t, h: 20 }; break;
      case "downRight": this.targetRect = { x: W - margin - t, y: H - margin - 20, w: t, h: 20 }; break;
      case "upLeft": this.targetRect = { x: margin, y: margin, w: t, h: 20 }; break;
      case "upRight": this.targetRect = { x: W - margin - t, y: margin, w: t, h: 20 }; break;
    }
  }

  setupWindowInteraction(): void {
    const refresh = () => requestPaint(this.canvas);
    for (const type of ["input", "change", "focusin", "focusout", "click"] as const) {
      windowEl.addEventListener(type, refresh);
    }
  }

  startAnimation(): void {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.playhead = 0;
    genieBtn.disabled = true;
    infoEl.textContent = "Animating…";

    const start = performance.now();
    const dur = this.animationDuration * 1000;

    const animate = () => {
      const p = Math.min(1, (performance.now() - start) / dur);
      this.playhead = p;
      this.present();
      if (p < 1) this.animationId = requestAnimationFrame(animate);
      else this.finishAnimation();
    };
    this.animationId = requestAnimationFrame(animate);
  }

  finishAnimation(): void {
    this.isAnimating = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.playhead = 1;
    this.present();
    genieBtn.disabled = false;
    infoEl.textContent = "Genie effect complete.";
  }

  reset(): void {
    if (this.isAnimating) {
      if (this.animationId !== null) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      this.isAnimating = false;
    }
    this.playhead = 0;
    this.present();
    genieBtn.disabled = false;
    infoEl.textContent = "Click 'Start Genie Effect' to animate the window.";
  }

  /** 唯一刷新入口（幂等）。 */
  present(): void {
    this.draw(this.playhead);
  }

  onResize(): void {
    applyCanvasSize();
    this.layoutFromDOM();
    this.createTexture();
  }

  private draw(progress: number): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup0) return;

    if (!this.isResizing && applyCanvasSize()) {
      this.isResizing = true;
      try { this.onResize(); } finally { this.isResizing = false; }
    }

    const d = renderScale.dpr;
    const fromPx: Rect = {
      x: toPx(this.windowRect.x), y: toPx(this.windowRect.y),
      w: toPx(this.windowRect.w), h: toPx(this.windowRect.h),
    };
    const toPxRect: Rect = {
      x: toPx(this.targetRect.x), y: toPx(this.targetRect.y),
      w: toPx(this.targetRect.w), h: toPx(this.targetRect.h),
    };
    const dirRaw = GENIE_DIRECTIONS[this.direction];
    const len = Math.hypot(dirRaw.x, dirRaw.y) || 1;
    const dir: Vec2 = { x: dirRaw.x / len, y: dirRaw.y / len };

    // 写 uniform。必须与 WGSL 结构体逐字段对齐（见 Genie.vertex.wgsl 的 Params）：
    //   0-1  viewport, 2-3 _pad0
    //   4-7  rect(x,y,w,h)
    //   8    time
    //   9    curveDuration
    //   10   translationDuration
    //   11   targetX
    //   12   targetY
    //   13   targetWidth
    //   14-15 _pad1
    const animTime = progress * this.animationDuration;
    const curveDur = this.animationDuration * this.curvePortion;
    const transDur = this.animationDuration - curveDur;

    const f = this.uniformScratch;
    f[0] = renderScale.pxW; f[1] = renderScale.pxH; f[2] = 0; f[3] = 0;
    f[4] = fromPx.x; f[5] = fromPx.y; f[6] = fromPx.w; f[7] = fromPx.h;
    f[8] = animTime;
    f[9] = curveDur;
    f[10] = transDur;
    f[11] = toPxRect.x + toPxRect.w * 0.5;   // 目标中心 X
    f[12] = toPxRect.y + toPxRect.h * 0.5;   // 目标中心 Y
    f[13] = toPxRect.w;                       // 最终宽度
    f[14] = 0; f[15] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, f);

    // 同步 DOM 命中几何。
    //
    // vb 是物理像素，先除以 dpr 转成 CSS 像素再交给 updateElementGeometry；
    // scale = 可见宽度 / 元素原始宽度，两者都用 CSS 像素。
    //
    // ⚠️ 两个端点要特判，否则命中盒会因"梯形包围盒大于梯形本身"而偏大：
    //   progress = 0 → 精确等于源矩形（窗口原样）
    //   progress = 1 → 精确等于目标矩形（已完全收进去）
    // 中间态用包围盒近似即可 —— 那时元素本就不可交互。
    let vb: Rect;
    if (progress <= 0) {
      vb = fromPx;
    } else if (progress >= 1) {
      vb = toPxRect;
    } else {
      vb = this.visibleBounds(fromPx, toPxRect, dir, progress);
    }

    // 同步 DOM 命中几何。
    //
    // ⚠️ 这里只做**等比缩放 + 平移**，不尝试用 canvasClip 精确裁出梯形：
    //   · scale 是单标量，宽高比变化时无法同时匹配宽高
    //   · canvasClip 的试错成本高（坐标系语义易错，且容易把命中区裁没）
    //   · 动画期间元素本就不可交互，精确度需求集中在首尾两端
    // 因此两端特判为精确矩形，中间态用等比缩放近似 —— 对可用性足够。
    const scaleW = vb.w / d / Math.max(1, this.windowRect.w);

    syncElementGeometry(
      this.canvas,
      windowEl,
      vb.x / d,
      vb.y / d,
      scaleW,
    );

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.12, b: 0.18, a: 1.0 },
        loadOp: "clear", storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup0);
    pass.draw(6);   // 两个三角形，无顶点缓冲
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 形变后的可见包围盒（物理像素）。
   *
   * 沿用 shader 的**正向**公式（即最初版的 sin 曲线），
   * 遍历源矩形边界采样点，算出它们最终落在屏幕的位置，取包围盒。
   * 与 shader 用同一套公式，避免命中盒与视觉错位。
   */
  private visibleBounds(from: Rect, to: Rect, dir: Vec2, progress: number): Rect {
    const perp = { x: -dir.y, y: dir.x };
    const fromC = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const toC = { x: to.x + to.w / 2, y: to.y + to.h / 2 };

    const halfA = Math.abs(dir.x) * (from.w / 2) + Math.abs(dir.y) * (from.h / 2);
    const halfP = Math.abs(perp.x) * (from.w / 2) + Math.abs(perp.y) * (from.h / 2);

    const t = Math.min(1, Math.max(0, progress));
    const curveP = Math.min(1, t / Math.max(this.curvePortion, 1e-4));
    const transP = t > this.curvePortion
      ? Math.min(1, (t - this.curvePortion) / Math.max(1 - this.curvePortion, 1e-4))
      : 0;

    // 与 draw() 里一致：由目标宽度比推导
    const widthRatio = Math.min(1, to.w / Math.max(from.w, 1));
    const leftMaxEnd = (1 - widthRatio) * 0.5;
    const rightMinEnd = 1 - leftMaxEnd;

    const leftMax = curveP * leftMaxEnd;
    const rightMin = 1 - curveP * (1 - rightMinEnd);
    const leftD = leftMax * 0.5;
    const leftA = leftD;
    const rightD = (rightMin + 1) * 0.5;
    const rightA = 1 - rightD;

    const travelComp = dir.x * (toC.x - fromC.x) + dir.y * (toC.y - fromC.y);
    const transX = (toC.x - fromC.x) * transP;
    const transY = (toC.y - fromC.y) * transP;

    const N = 24;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const emit = (ua: number, va: number): void => {
      // 源局部坐标 → 归一化 v/u
      const aSrc = ua * halfA;
      const v = (aSrc / Math.max(halfA, 1e-4) + 1) * 0.5;
      const u = (va * halfP / Math.max(halfP, 1e-4) + 1) * 0.5;

      // 该行的左右边界（sin 曲线）
      const leftCurve = leftA * Math.sin(Math.PI * v - Math.PI * 0.5) + leftD;
      const rightCurve = rightA * Math.sin(Math.PI * v + Math.PI * 0.5) + rightD;

      // 横向被映射到 [leftCurve, rightCurve] 区间内
      const uMapped = leftCurve + u * (rightCurve - leftCurve);

      // 还原成画布像素
      const aOut = aSrc + travelComp * transP;
      const pOut = (uMapped * 2 - 1) * halfP;

      const px = fromC.x + dir.x * aOut + perp.x * pOut + (transX - dir.x * travelComp * transP);
      const py = fromC.y + dir.y * aOut + perp.y * pOut + (transY - dir.y * travelComp * transP);

      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    };

    for (let i = 0; i <= N; i++) {
      const q = (i / N) * 2 - 1;   // -1..1
      emit(q, -1);
      emit(q, 1);
      emit(-1, q);
      emit(1, q);
    }

    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
}

async function run(): Promise<void> {
  const gpu = await initWebGPU();
  if (!gpu) return;
  const app = new GenieApp(gpu.device, gpu.context, gpu.canvasFormat, gpu.canvas);
  await app.init();
  (window as unknown as { __app: GenieApp }).__app = app;
}

run();
